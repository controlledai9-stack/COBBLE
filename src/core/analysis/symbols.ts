import ts from "typescript";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { extractContracts } from "../graph";
import type { Change } from "../../shared/types";

export const SYMBOL_LIMITS = Object.freeze({
  changedFiles: 32,
  sourceCharacters: 2_000_000,
  fileCharacters: 256_000,
  symbols: 400,
  imports: 128,
  contextFiles: 16,
  contextCharacters: 256_000,
  depth: 2,
  spansPerSymbol: 8,
  symbolCharacters: 160_000,
});
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const supported = (path: string) => /\.[cm]?[jt]sx?$/i.test(path);
export interface SourceSpan {
  sourceHash: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
export interface SymbolChange {
  path: string;
  name: string;
  kind: string;
  change: "added" | "removed" | "implementation" | "interface";
  publicShape: "changed" | "unchanged" | "unknown" | "not_public";
  before: SourceSpan[];
  after: SourceSpan[];
}
export interface DependencyCapture {
  version: 1;
  basis: "after_checkpoint";
  files: { path: string; source: string; sourceHash: string }[];
  edges: {
    from: string;
    specifier: string;
    target?: string;
    status: "resolved" | "external" | "missing" | "ambiguous" | "budget";
  }[];
  partial: boolean;
}
export interface SymbolEvidence {
  version: 1;
  files: {
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
    status: "analyzed" | "formatting_only" | "unchanged" | "unknown";
    reasons: string[];
  }[];
  symbols: SymbolChange[];
  dependencies: Omit<DependencyCapture, "files"> & {
    files: { path: string; sourceHash: string }[];
  };
  coverage: {
    partial: boolean;
    omittedFiles: number;
    omittedSymbols: number;
    limits: typeof SYMBOL_LIMITS;
    limitations: string[];
  };
}
function parse(path: string, source: string) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/i.test(path)
      ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(path)
        ? ts.ScriptKind.JSX
        : /\.[cm]?js$/i.test(path)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
}
function hasSyntaxErrors(file: ts.SourceFile) {
  return (
    (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length > 0
  );
}
function semanticDirectives(file: ts.SourceFile): string {
  // JSDoc types and compiler directives can affect the public surface even though they are comments.
  const comments = file.text.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g) ?? [];
  return JSON.stringify({
    comments: comments.filter((text) =>
      /@(?:ts-|param\b|returns?\b|type\b|typedef\b|template\b|import\b|satisfies\b|implements\b|extends\b|override\b|deprecated\b|private\b|protected\b|public\b|readonly\b|enum\b|callback\b|overload\b|this\b|constructor\b)|<reference\s/i.test(
        text,
      ),
    ),
  });
}
function span(file: ts.SourceFile, node: ts.Node, hash: string): SourceSpan {
  const start = node.getStart(file);
  const end = node.getEnd();
  return {
    sourceHash: hash,
    start,
    end,
    startLine: file.getLineAndCharacterOfPosition(start).line + 1,
    endLine:
      file.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
  };
}
// Tree structure preserves ASI, operators, regex and template/JSX text. Trivia and optional semicolons do not change identity.
function canonical(node: ts.Node, file: ts.SourceFile, depth = 0): string {
  if (depth > 200) throw new Error("Syntax nesting limit");
  if (
    (node.kind === ts.SyntaxKind.SemicolonToken &&
      node.parent?.kind !== ts.SyntaxKind.ForStatement) ||
    node.kind === ts.SyntaxKind.EndOfFileToken ||
    (node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode)
  )
    return "";
  const children = node.getChildren(file);
  return children.length
    ? `${node.kind}[${children
        .map((child) => canonical(child, file, depth + 1))
        .filter(Boolean)
        .join(",")}]`
    : JSON.stringify([
        node.kind,
        ts.isStringLiteral(node) ? node.text : node.getText(file),
      ]);
}
type Declaration = {
  name: string;
  kind: string;
  nodes: ts.Node[];
  exported: boolean;
};
function declarations(file: ts.SourceFile): Declaration[] {
  const groups = new Map<string, Declaration>();
  const exportedNames = new Set<string>();
  for (const node of file.statements) {
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    )
      for (const element of node.exportClause.elements)
        exportedNames.add((element.propertyName ?? element.name).text);
  }
  const isExported = (node: ts.Node) =>
    !!(
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
  const add = (
    name: string,
    kind: string,
    node: ts.Node,
    exported: boolean,
  ) => {
    const key = `${kind}:${name}`;
    const previous = groups.get(key);
    if (previous) previous.nodes.push(node);
    else groups.set(key, { name, kind, nodes: [node], exported });
  };
  for (const node of file.statements) {
    const named =
      ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        ? (node.name?.text ?? "default")
        : "";
    if (ts.isFunctionDeclaration(node))
      add(
        named,
        "function",
        node,
        isExported(node) || exportedNames.has(named),
      );
    else if (ts.isClassDeclaration(node)) {
      const publicClass = isExported(node) || exportedNames.has(named);
      add(named, "class", node, publicClass);
      for (const member of node.members) {
        if (
          !member.name ||
          !(
            ts.isMethodDeclaration(member) ||
            ts.isGetAccessor(member) ||
            ts.isSetAccessor(member) ||
            ts.isPropertyDeclaration(member)
          )
        )
          continue;
        const privateMember =
          ts.isPrivateIdentifier(member.name) ||
          !!ts
            .getModifiers(member)
            ?.some(
              (m) =>
                m.kind === ts.SyntaxKind.PrivateKeyword ||
                m.kind === ts.SyntaxKind.ProtectedKeyword,
            );
        add(
          `${named}.${member.name.getText(file)}`,
          ts.isPropertyDeclaration(member) ? "property" : "method",
          member,
          publicClass && !privateMember,
        );
      }
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    )
      add(
        node.name.text,
        ts.isInterfaceDeclaration(node) ? "interface" : "type",
        node,
        isExported(node) || exportedNames.has(node.name.text),
      );
    else if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        add(
          declaration.name.text,
          declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
            ? "function"
            : "variable",
          declaration,
          isExported(node) || exportedNames.has(declaration.name.text),
        );
      }
  }
  return [...groups.values()];
}
function imports(file: ts.SourceFile): {
  specifiers: string[];
  partial: boolean;
} {
  const specifiers = new Set<string>();
  let partial = false;
  function walk(node: ts.Node, depth = 0) {
    if (depth > 200) {
      partial = true;
      return;
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      partial = true; // No execution or runtime resolution, even for a literal dynamic import.
    }
    if (ts.isImportEqualsDeclaration(node)) partial = true;
    if (specifiers.size > SYMBOL_LIMITS.imports) {
      partial = true;
      return;
    }
    ts.forEachChild(node, (child) => walk(child, depth + 1));
  }
  walk(file);
  return {
    specifiers: [...specifiers].slice(0, SYMBOL_LIMITS.imports),
    partial,
  };
}
/** Capture only bounded static relative imports from the SAME saved after-checkpoint. Never read live files. */
export function captureDependencies(
  changes: Change[],
  baseline: Map<string, string>,
): DependencyCapture {
  const result: DependencyCapture = {
    version: 1,
    basis: "after_checkpoint",
    files: [],
    edges: [],
    partial: false,
  };
  const sources = new Map(baseline);
  for (const change of changes)
    if (change.after === null) sources.delete(change.path);
    else sources.set(change.path, change.after);
  const changed = new Set(changes.map((c) => c.path));
  const queue = changes
    .slice(0, SYMBOL_LIMITS.changedFiles)
    .filter((c) => c.after !== null)
    .map((c) => ({ path: c.path, depth: 0 }));
  const seen = new Set<string>();
  let characters = 0,
    parsedCharacters = 0;
  if (changes.length > SYMBOL_LIMITS.changedFiles) result.partial = true;
  while (queue.length) {
    const entry = queue.shift()!;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const source = sources.get(entry.path);
    if (source === undefined || !supported(entry.path)) {
      result.partial = true;
      continue;
    }
    if (
      source.length > SYMBOL_LIMITS.fileCharacters ||
      parsedCharacters + source.length > SYMBOL_LIMITS.sourceCharacters
    ) {
      result.partial = true;
      continue;
    }
    parsedCharacters += source.length;
    let found: ReturnType<typeof imports>;
    try {
      const file = parse(entry.path, source);
      found = imports(file);
      found.partial ||= hasSyntaxErrors(file);
    } catch {
      result.partial = true;
      continue;
    }
    result.partial ||= found.partial;
    for (const specifier of found.specifiers) {
      if (specifier.length > 1024) {
        result.partial = true;
        continue;
      }
      if (result.edges.length >= SYMBOL_LIMITS.imports) {
        result.partial = true;
        break;
      }
      const edge: DependencyCapture["edges"][number] = {
        from: entry.path,
        specifier,
        status: "external",
      };
      if (/^\.{1,2}(?:\/|$)/.test(specifier)) {
        const target = posix.normalize(
          posix.join(posix.dirname(entry.path), specifier),
        );
        const candidates = new Set([
          target,
          ...[
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            "/index.ts",
            "/index.tsx",
            "/index.js",
            "/index.jsx",
          ].map((ext) => target + ext),
        ]);
        if (/\.[cm]?jsx?$/.test(target))
          for (const ext of [".ts", ".tsx", ".mts", ".cts"])
            candidates.add(target.replace(/\.[cm]?jsx?$/, ext));
        const matches = [...candidates].filter(
          (path) =>
            !path.startsWith("../") &&
            !posix.isAbsolute(path) &&
            sources.has(path),
        );
        edge.status =
          matches.length === 1
            ? "resolved"
            : matches.length
              ? "ambiguous"
              : "missing";
        if (matches.length === 1) {
          const path = matches[0],
            text = sources.get(path)!;
          const included =
            changed.has(path) || result.files.some((f) => f.path === path);
          if (
            !included &&
            (entry.depth >= SYMBOL_LIMITS.depth ||
              result.files.length >= SYMBOL_LIMITS.contextFiles ||
              text.length > SYMBOL_LIMITS.fileCharacters ||
              characters + text.length > SYMBOL_LIMITS.contextCharacters ||
              !supported(path))
          )
            edge.status = "budget";
          else {
            edge.target = path;
            if (!included) {
              result.files.push({
                path,
                source: text,
                sourceHash: digest(text),
              });
              characters += text.length;
            }
            if (entry.depth < SYMBOL_LIMITS.depth)
              queue.push({ path, depth: entry.depth + 1 });
          }
        }
      }
      if (edge.status !== "resolved") result.partial = true;
      result.edges.push(edge);
    }
  }
  return result;
}

/** Syntax evidence only: no type checker, program execution, scope judgment or notification authority. */
export function analyzeSymbols(
  changes: Change[],
  dependencies?: DependencyCapture,
): SymbolEvidence {
  const captured = dependencies ?? {
    version: 1 as const,
    basis: "after_checkpoint" as const,
    files: [],
    edges: [],
    partial: true,
  };
  const result: SymbolEvidence = {
    version: 1,
    files: [],
    symbols: [],
    dependencies: {
      ...captured,
      files: captured.files.map(({ path, sourceHash }) => ({
        path,
        sourceHash,
      })),
    },
    coverage: {
      partial: captured.partial,
      omittedFiles: 0,
      omittedSymbols: 0,
      limits: SYMBOL_LIMITS,
      limitations: [
        "Syntax evidence is not proof of necessity, behavior, type compatibility or plan deviation.",
        "Only top-level declarations and class members are named; nested bodies stay in their enclosing declaration.",
        "Static relative imports use bounded checkpoint candidates, not project/compiler/package resolution; dynamic code stays unknown.",
        "Dependency context is from the saved after-checkpoint; it does not reconstruct an unchanged dependency's before revision.",
      ],
    },
  };
  if (!dependencies)
    result.coverage.limitations.push(
      "This evidence batch has no captured dependency context; it is not reconstructed from later live files.",
    );
  let characters = 0;
  let symbolCharacters = 0;
  for (const [index, change] of changes.entries()) {
    const record: SymbolEvidence["files"][number] = {
      path: change.path,
      beforeHash: change.before === null ? null : digest(change.before),
      afterHash: change.after === null ? null : digest(change.after),
      status: "unknown",
      reasons: [],
    };
    if (index >= SYMBOL_LIMITS.changedFiles) {
      result.coverage.omittedFiles++;
      result.coverage.partial = true;
      continue;
    }
    result.files.push(record);
    if (!supported(change.path)) {
      record.reasons.push("Unsupported language");
      result.coverage.partial = true;
      continue;
    }
    const cost = (change.before?.length ?? 0) + (change.after?.length ?? 0);
    if (
      Math.max(change.before?.length ?? 0, change.after?.length ?? 0) >
        SYMBOL_LIMITS.fileCharacters ||
      characters + cost > SYMBOL_LIMITS.sourceCharacters
    ) {
      record.reasons.push("Source budget exceeded");
      result.coverage.partial = true;
      continue;
    }
    characters += cost;
    try {
      const before = parse(change.path, change.before ?? ""),
        after = parse(change.path, change.after ?? "");
      if ([before, after].some(hasSyntaxErrors))
        throw new Error("Syntax errors; no reliable symbol comparison");
      if (semanticDirectives(before) !== semanticDirectives(after)) {
        record.reasons.push(
          "Type-bearing comments or compiler directives changed; their semantic effects are unresolved",
        );
        result.coverage.partial = true;
      }
      if (
        change.before !== null &&
        change.after !== null &&
        canonical(before, before) === canonical(after, after)
      ) {
        record.status = record.reasons.length
          ? "unknown"
          : change.before === change.after
            ? "unchanged"
            : "formatting_only";
        continue;
      }
      record.status = "analyzed";
      const a = new Map(
        declarations(before).map((d) => [`${d.kind}:${d.name}`, d]),
      );
      const b = new Map(
        declarations(after).map((d) => [`${d.kind}:${d.name}`, d]),
      );
      const contracts = [
        extractContracts(change.path, change.before ?? "", "symbols"),
        extractContracts(change.path, change.after ?? "", "symbols"),
      ];
      const dynamic =
        /\b(?:module\s*\.\s*exports|exports\s*[.\[])|\beval\s*\(/.test(
          `${change.before ?? ""}\n${change.after ?? ""}`,
        );
      if (dynamic || imports(before).partial || imports(after).partial) {
        record.reasons.push("Dynamic/CommonJS syntax is not resolved");
        result.coverage.partial = true;
      }
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        const old = a.get(key),
          next = b.get(key);
        if (
          old &&
          next &&
          old.exported === next.exported &&
          old.nodes.map((n) => canonical(n, before)).join() ===
            next.nodes.map((n) => canonical(n, after)).join()
        )
          continue;
        const declaration = next ?? old!;
        let publicShape: SymbolChange["publicShape"] = "not_public";
        if (dynamic || old?.exported || next?.exported) {
          const ca = contracts[0].find((c) => c.name === declaration.name),
            cb = contracts[1].find((c) => c.name === declaration.name);
          publicShape = dynamic
            ? "unknown"
            : !old || !next || old.exported !== next.exported
              ? "changed"
              : !ca ||
                  !cb ||
                  ca.signature.includes('"inferred"') ||
                  cb.signature.includes('"inferred"')
                ? "unknown"
                : ca.signature !== cb.signature
                  ? "changed"
                  : "unchanged";
        }
        if (result.symbols.length >= SYMBOL_LIMITS.symbols) {
          result.coverage.omittedSymbols++;
          result.coverage.partial = true;
          continue;
        }
        if (publicShape === "unknown") result.coverage.partial = true;
        if (
          (old?.nodes.length ?? 0) > SYMBOL_LIMITS.spansPerSymbol ||
          (next?.nodes.length ?? 0) > SYMBOL_LIMITS.spansPerSymbol
        ) {
          record.reasons.push("Overload reference budget exceeded");
          result.coverage.partial = true;
        }
        const evidence: SymbolChange = {
          path: change.path,
          name: declaration.name,
          kind: declaration.kind,
          change: !old
            ? "added"
            : !next
              ? "removed"
              : publicShape === "changed"
                ? "interface"
                : "implementation",
          publicShape,
          before:
            old?.nodes
              .slice(0, SYMBOL_LIMITS.spansPerSymbol)
              .map((n) => span(before, n, record.beforeHash!)) ?? [],
          after:
            next?.nodes
              .slice(0, SYMBOL_LIMITS.spansPerSymbol)
              .map((n) => span(after, n, record.afterHash!)) ?? [],
        };
        const size = JSON.stringify(evidence).length;
        if (symbolCharacters + size > SYMBOL_LIMITS.symbolCharacters) {
          result.coverage.omittedSymbols++;
          result.coverage.partial = true;
        } else {
          result.symbols.push(evidence);
          symbolCharacters += size;
        }
      }
      // Executable top-level statements, re-exports and other unsupported declarations remain explicit coverage gaps.
      if (
        [before, after].some((file) =>
          file.statements.some(
            (n) =>
              !(
                ts.isFunctionDeclaration(n) ||
                ts.isClassDeclaration(n) ||
                ts.isVariableStatement(n) ||
                ts.isInterfaceDeclaration(n) ||
                ts.isTypeAliasDeclaration(n) ||
                ts.isImportDeclaration(n) ||
                ts.isEmptyStatement(n)
              ),
          ),
        )
      ) {
        record.reasons.push(
          "Top-level executable or unsupported declaration syntax",
        );
        result.coverage.partial = true;
      }
    } catch (error) {
      record.status = "unknown";
      record.reasons.push(
        error instanceof Error ? error.message : "Parser failed",
      );
      result.coverage.partial = true;
    }
  }
  return result;
}
