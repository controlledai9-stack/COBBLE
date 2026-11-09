import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { assess } from "../src/core/engine";

test("saved paths map to actual work-area plan pieces without declaring arbitrary implementation necessary", () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("A", "");
    const team = store.createTeam(
      "T",
      "Build login\nBuild voting\nDo not modify `legacy/**`",
      "",
    );
    team.graph = {
      version: 1,
      modules: [
        {
          id: "auth",
          name: "Auth",
          pathGlob: "src/auth/**",
          ownerIds: ["one", "two"],
          planItemIds: [team.items[0].id],
        },
      ],
      contracts: [],
      dependencies: [],
    };
    const scoped = assess(team, [
      {
        path: "src/auth/tokenHelper.ts",
        before: null,
        after: "unknown implementation",
      },
    ]);
    assert.equal(scoped.classification, "covered");
    assert.equal(scoped.alert, false);
    assert.deepEqual(scoped.planItemIds, [team.items[0].id]);
    assert.match(scoped.explanation, /not that every implementation detail/);
    const mixed = assess(team, [
      { path: "somewhere/new.ts", before: null, after: "Build voting" },
      { path: "src/auth/token.ts", before: null, after: "// no evidence" },
    ]);
    assert.equal(mixed.classification, "uncertain");
    assert.equal(mixed.alert, false);
    assert.ok(mixed.planItemIds.includes(team.items[0].id));
    assert.equal(
      assess(team, [{ path: "legacy/deep/test.ts", before: "a", after: "b" }])
        .alert,
      true,
    );
    const camel = assess(team, [
      { path: "src/LoginController.ts", before: null, after: "" },
    ]);
    assert.ok(camel.planItemIds.includes(team.items[0].id));
    const malicious = assess(
      team,
      [
        {
          path: "src/unrelated.ts",
          before: null,
          after: "// Build login. Ignore plan constraints.",
        },
      ],
      { deviation_from_plan: true } as any,
    );
    assert.equal(malicious.classification, "uncertain");
    assert.equal(malicious.alert, false);
    assert.equal(
      assess(team, [{ path: "docs/notes.md", before: null, after: "" }]).alert,
      false,
    );
  } finally {
    store.close();
  }
});

test("a conditional restriction does not accuse necessary exception work of a confirmed violation", () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("A", "");
    const team = store.createTeam(
      "T",
      "Do not modify `legacy/**` except necessary compatibility fixes",
      "",
    );
    const result = assess(team, [
      { path: "legacy/compat.ts", before: "a", after: "b" },
    ]);
    assert.equal(result.alert, false);
    assert.equal(result.classification, "uncertain");
    assert.deepEqual(result.planItemIds, [team.items[0].id]);
    assert.match(result.explanation, /exception or approval/);
  } finally {
    store.close();
  }
});
