import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeSymbols,
  captureDependencies,
  SYMBOL_LIMITS,
} from "../src/core/analysis/symbols";
import { Store } from "../src/core/store";
import { AnalysisLedger } from "../src/core/analysis/ledger";
import { CobbleService } from "../src/core/service";
import { assess } from "../src/core/engine";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const compare = (
  before: string | null,
  after: string | null,
  path = "src/a.ts",
) =>
  analyzeSymbols(
    [{ path, before, after }],
    captureDependencies([{ path, before, after }], new Map()),
  );

test("formatting and comments are quiet without erasing literal, operator, regex, JSX or ASI changes", () => {
  const formatting = compare(
    "/** old docs */\nexport function f(x: number): string {return 'a b';}",
    '// revised docs\nexport function f(x:number):string {\n return "a b"\n}\n',
  );
  assert.equal(formatting.files[0].status, "formatting_only");
  assert.equal(formatting.symbols.length, 0);
  for (const [before, after, path] of [
    ["const f = () => 'a b'", "const f = () => 'ab'", "a.ts"],
    ["const f = () => `a b`", "const f = () => `ab`", "a.ts"],
    ["const f = () => /a b/", "const f = () => /ab/", "a.ts"],
    ["const f = () => 1 + 2", "const f = () => 1 - 2", "a.ts"],
    [
      "function f(){ for (; a; b) {} }",
      "function f(){ for (a; ; b) {} }",
      "a.ts",
    ],
    ["function f() { return 1; }", "function f() { return\n1; }", "a.ts"],
    ["const f = () => <b>a b</b>", "const f = () => <b>ab</b>", "a.tsx"],
  ]) {
    const result = compare(before, after, path);
    assert.notEqual(result.files[0].status, "formatting_only", path);
    assert.ok(result.symbols.length, `${before} -> ${after}`);
  }
});

test("changed functions retain exact hash-pinned UTF-16 source spans and public-shape distinctions", () => {
  const before =
    "// 🐢\nfunction helper(x: number): number { return x + 1; }\nexport function api(x: number): number { return helper(x); }";
  const after =
    "// 🐢\nfunction helper(x: number): number { return x + 2; }\nexport function api(x: string): number { return helper(Number(x)); }";
  const result = compare(before, after);
  assert.equal(
    result.symbols.find((s) => s.name === "helper")!.publicShape,
    "not_public",
  );
  assert.equal(
    result.symbols.find((s) => s.name === "api")!.change,
    "interface",
  );
  for (const symbol of result.symbols)
    for (const [source, spans] of [
      [before, symbol.before],
      [after, symbol.after],
    ] as const) {
      assert.equal(spans[0].sourceHash, hash(source));
      assert.ok(
        source
          .slice(spans[0].start, spans[0].end)
          .startsWith(symbol.name === "api" ? "export function" : "function"),
      );
      assert.ok(spans[0].startLine >= 2);
    }
  assert.equal(
    compare(
      "export function f(x: number): number { return x; }",
      "export function f(x: number): number { return x + 1; }",
    ).symbols[0].publicShape,
    "unchanged",
  );
  assert.equal(
    compare(
      "export function f() { return 1; }",
      "export function f() { return 'changed'; }",
    ).symbols[0].publicShape,
    "unknown",
  );
});

test("adds, removals, export-list changes, private methods and overloads remain explicit", () => {
  assert.equal(
    compare(null, "export const f = (): number => 1").symbols[0].change,
    "added",
  );
  assert.equal(compare("function f() {}", null).symbols[0].change, "removed");
  const exportChange = compare(
    "function f() {}",
    "function f() {}\nexport { f }",
  );
  assert.equal(exportChange.symbols[0].publicShape, "changed");
  assert.equal(exportChange.coverage.partial, true);
  const privateMethod = compare(
    "export class A { private f(): number { return 1; } }",
    "export class A { private f(): number { return 2; } }",
  );
  assert.equal(
    privateMethod.symbols.find((s) => s.name === "A.f")!.publicShape,
    "not_public",
  );
  assert.equal(
    privateMethod.symbols.find((s) => s.name === "A")!.publicShape,
    "unchanged",
  );
  const overloads = compare(
    "export function f(x: string): string; export function f(x: any): any { return x; }",
    "export function f(x: number): number; export function f(x: any): any { return x; }",
  );
  assert.equal(overloads.symbols[0].before.length, 2);
  assert.equal(overloads.symbols[0].publicShape, "changed");
});

test("unsupported, broken, dynamic and budget-limited sources cannot look fully checked", () => {
  for (const result of [
    compare("x = 1", "x = 2", "a.py"),
    compare("function f() {}", "function f( {"),
    compare(
      "function f(){return 1}; module.exports = f",
      "function f(){return 2}; module.exports = f",
    ),
    compare("const f = () => import(name)", "const f = () => import(other)"),
    compare("", "x".repeat(SYMBOL_LIMITS.fileCharacters + 1)),
  ])
    assert.equal(result.coverage.partial, true);
  const commonJS = compare(
    "function f(){return 1}; module.exports = f",
    "function f(){return 2}; module.exports = f",
  );
  assert.equal(commonJS.symbols[0].publicShape, "unknown");
  for (const [before, after] of [
    [
      "/** @param {number} x */\nexport function f(x) {return x}",
      "/** @param {string} x */\nexport function f(x) {return x}",
    ],
    [
      '/// <reference types="node" />\nexport const f = 1',
      '/// <reference types="other" />\nexport const f = 1',
    ],
    ["// @ts-nocheck\nexport const f = 1", "export const f = 1"],
  ]) {
    const result = compare(before, after);
    assert.equal(result.files[0].status, "unknown");
    assert.equal(result.coverage.partial, true);
  }
  const changes = Array.from({ length: 40 }, (_, i) => ({
    path: `${i}.ts`,
    before: null,
    after: "function f(){}",
  }));
  const bounded = analyzeSymbols(changes);
  assert.equal(bounded.files.length, SYMBOL_LIMITS.changedFiles);
  assert.equal(bounded.coverage.omittedFiles, 8);
  const many = compare(
    null,
    Array.from({ length: 500 }, (_, i) => `function f${i}(){}`).join("\n"),
  );
  assert.equal(many.symbols.length, SYMBOL_LIMITS.symbols);
  assert.equal(many.coverage.omittedSymbols, 100);
});

test("dependency context is checkpoint-pinned, bounded, cycle-safe and honest about resolution", () => {
  const changes = [
    {
      path: "src/main.ts",
      before: "",
      after:
        "import './a'; import './ambiguous'; import './missing'; import '../outside'; import 'pkg';",
    },
  ];
  const baseline = new Map([
    ["src/a.ts", "import './b'; export const value = 1;"],
    ["src/b.ts", "import './a'; import './c';"],
    ["src/c.ts", "export const value = 3;"],
    ["src/ambiguous.ts", ""],
    ["src/ambiguous.js", ""],
  ]);
  const context = captureDependencies(changes, baseline);
  baseline.set("src/a.ts", "NEW UNSAVED CHECKPOINT");
  assert.ok(
    context.files
      .find((f) => f.path === "src/a.ts")!
      .source.includes("value = 1"),
  );
  for (const file of context.files)
    assert.equal(file.sourceHash, hash(file.source));
  assert.equal(
    context.edges.find((e) => e.specifier === "./ambiguous")!.status,
    "ambiguous",
  );
  assert.equal(
    context.edges.find((e) => e.specifier === "./missing")!.status,
    "missing",
  );
  assert.equal(
    context.edges.find((e) => e.specifier === "pkg")!.status,
    "external",
  );
  assert.equal(
    context.edges.find((e) => e.specifier === "./c")!.status,
    "budget",
  );
  assert.equal(context.files.length, 2);
  const manyImports = {
    path: "src/main.ts",
    before: "",
    after: Array.from({ length: 30 }, (_, i) => `import './d${i}';`).join("\n"),
  };
  const manyFiles = new Map(
    Array.from({ length: 30 }, (_, i) => [`src/d${i}.ts`, "export const a=1;"]),
  );
  const limited = captureDependencies([manyImports], manyFiles);
  assert.equal(limited.files.length, SYMBOL_LIMITS.contextFiles);
  assert.equal(limited.partial, true);
  const packet = analyzeSymbols(changes, context);
  assert.ok(
    !JSON.stringify(packet.dependencies).includes('source":'),
    "Result metadata does not duplicate raw source",
  );
});

test("symbol context survives service restart, stays device-local and does not create a scope accusation", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cobble-symbols-")));
  const file = join(dir, "db.sqlite");
  const store = new Store(file);
  const profile = store.saveProfile("Author", "");
  const team = store.createTeam("Evidence", "Build backend", dir);
  const before =
    "import './helper'; export function feature(): number { return 1; }";
  const after =
    "import './helper'; export function feature(): number { return 2; }";
  const changes = [{ path: "app.ts", before, after }];
  const batch = new AnalysisLedger(store).capture(
    team,
    profile,
    dir,
    changes,
    new Map([
      ["app.ts", after],
      ["helper.ts", "export const helper=1;"],
    ]),
    [],
    { kind: "saved_checkpoint" },
  );
  assert.equal(assess(team, changes).alert, false);
  assert.equal(
    store.syncRows(team.id, 0).some((row) => row.data.includes("sourceHash")),
    false,
  );
  store.close();
  await writeFile(join(dir, "app.ts"), after);
  await writeFile(join(dir, "helper.ts"), "export const helper=1;");
  const service = new CobbleService(file);
  try {
    await service.start();
    const row = service.store.db
      .prepare("SELECT data FROM analysis_jobs WHERE status='completed'")
      .get() as { data: string };
    const job = JSON.parse(row.data);
    assert.equal(job.result.symbols.symbols[0].name, "feature");
    assert.equal(job.result.symbols.dependencies.files[0].path, "helper.ts");
    assert.equal(
      service.analysis.batch(batch.id).dependencyContext!.files[0].source,
      "export const helper=1;",
    );
    assert.equal(service.state().activities[0].alert, false);
    assert.ok(
      !JSON.stringify(service.state().activities).includes("sourceHash"),
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
