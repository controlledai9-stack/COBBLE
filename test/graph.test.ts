import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractContracts,
  deriveDependencies,
  impact,
} from "../src/core/graph";
import type { Team } from "../src/shared/types";
test("contract capture ignores body, formatting and positional parameter renames", () => {
  const first = extractContracts(
    "api.ts",
    "export function getUsers(limit: number): string[] { return []; }",
    "m",
  );
  const second = extractContracts(
    "api.ts",
    '// new comment\nexport function getUsers( count : number ) : string [] { return ["a"]; }',
    "m",
  );
  assert.equal(first[0].signature, second[0].signature);
  assert.notEqual(
    first[0].signature,
    extractContracts(
      "api.ts",
      "export function getUsers(limit: string): string[] { return []; }",
      "m",
    )[0].signature,
  );
});
test("named object shapes are order-independent and function overloads are grouped", () => {
  assert.equal(
    extractContracts(
      "a.ts",
      "export interface User { name: string; id: number; }",
      "m",
    )[0].signature,
    extractContracts(
      "a.ts",
      "export interface User { id:number; name:string }",
      "m",
    )[0].signature,
  );
  const contracts = extractContracts(
    "a.ts",
    "export function run(x:string):string; export function run(x:number):number; export function run(x:any):any{return x;}",
    "m",
  );
  assert.equal(contracts.length, 1);
  assert.match(contracts[0].signature, /overloads/);
});
test("public API changes find dependent owners while private implementation changes stay quiet", () => {
  const initial =
    "export class Service { #secret: number=1; getUsers(): string[] {return [];} }";
  const captured = extractContracts("src/backend/api.ts", initial, "back");
  const team: Team = {
    id: "t",
    name: "T",
    code: "code",
    ownerId: "a",
    version: 1,
    plan: "Build",
    items: [],
    workspace: "",
    createdAt: "",
    graph: {
      version: 1,
      modules: [
        {
          id: "back",
          name: "Backend",
          ownerIds: ["a", "b"],
          pathGlob: "src/backend/**",
          planItemIds: [],
        },
        {
          id: "front",
          name: "Frontend",
          ownerIds: ["c"],
          pathGlob: "src/frontend/**",
          planItemIds: [],
        },
      ],
      contracts: captured,
      dependencies: [{ from: "front", to: "back" }],
    },
  };
  const quiet = impact(
    team,
    [
      {
        path: "src/backend/api.ts",
        before: initial,
        after: initial.replace(
          "#secret: number=1",
          '#secret: string="private"',
        ),
      },
    ],
    "b",
  );
  assert.equal(
    quiet.findings.some((f) => f.type === "contract" || f.type === "ownership"),
    false,
  );
  const changed = impact(
    team,
    [
      {
        path: "src/backend/api.ts",
        before: initial,
        after: initial.replace("getUsers(): string[]", "getUsers(): number[]"),
      },
    ],
    "a",
  );
  assert.ok(changed.findings.some((f) => f.type === "contract"));
  assert.deepEqual(new Set(changed.impactedMemberIds), new Set(["b", "c"]));
});
test("route capture and observed module dependencies cover normal JS/TS modules", () => {
  assert.ok(
    extractContracts("routes.ts", 'router.post("/users", handler);', "m").some(
      (c) => c.kind === "endpoint" && c.name === "POST /users",
    ),
  );
  const graph = {
    version: 1,
    modules: [
      {
        id: "ui",
        name: "UI",
        ownerIds: ["a"],
        pathGlob: "src/frontend/**",
        planItemIds: [],
      },
      {
        id: "api",
        name: "API",
        ownerIds: ["b"],
        pathGlob: "src/backend/**",
        planItemIds: [],
      },
    ],
    contracts: [],
    dependencies: [],
  };
  const edges = deriveDependencies(
    graph,
    new Map([
      ["src/frontend/app.ts", 'import { users } from "../backend/api";'],
      ["src/backend/api.ts", "export const users=[];"],
    ]),
  );
  assert.deepEqual(edges, [{ from: "ui", to: "api", source: "observed" }]);
});
