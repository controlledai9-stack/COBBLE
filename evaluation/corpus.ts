import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import Ajv from "ajv";
import type { Corpus } from "./types";
const text = { type: "string", minLength: 1, maxLength: 12000 };
const id = { type: "string", pattern: "^[a-z][a-z0-9-]{0,79}$" };
const list = (items: unknown, maxItems = 100) => ({
  type: "array",
  maxItems,
  items,
});
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const schema = object(
  {
    version: { const: 1 },
    provenance: { const: "synthetic-unreviewed" },
    projects: {
      ...list(
        object(
          {
            id,
            family: id,
            partition: { enum: ["development", "calibration", "heldout"] },
            requirements: {
              ...list(object({ key: id, text }, ["key", "text"])),
              minItems: 1,
            },
            modules: list(
              object(
                {
                  id,
                  path: text,
                  owners: list(id),
                  requirements: list(id),
                  reviewers: list(id),
                },
                ["id", "path", "owners", "requirements"],
              ),
            ),
            dependencies: list(object({ from: id, to: id }, ["from", "to"])),
            contracts: list(
              object({ module: id, path: text, source: text }, [
                "module",
                "path",
                "source",
              ]),
            ),
            cases: {
              ...list(
                object(
                  {
                    id,
                    group: id,
                    tags: list(id),
                    language: { enum: ["en", "hi-en"] },
                    query: text,
                    actor: id,
                    changes: list(
                      object(
                        {
                          path: text,
                          before: {
                            type: ["string", "null"],
                            maxLength: 64000,
                          },
                          after: { type: ["string", "null"], maxLength: 64000 },
                        },
                        ["path", "before", "after"],
                      ),
                      20,
                    ),
                    exceptions: list(
                      object(
                        {
                          requirement: id,
                          paths: list(text, 20),
                          authors: list(id, 20),
                          state: {
                            enum: [
                              "active",
                              "expired",
                              "revoked",
                              "old-membership",
                            ],
                          },
                        },
                        ["requirement", "paths", "authors", "state"],
                      ),
                    ),
                    observedSecondsAgo: {
                      type: "integer",
                      minimum: 0,
                      maximum: 3600,
                    },
                    expected: object(
                      {
                        scope: {
                          enum: ["allowed", "support", "conflict", "ambiguous"],
                        },
                        links: list(id),
                        rationale: text,
                        policyGate: { type: "boolean" },
                        audience: list(id),
                      },
                      ["scope", "links", "rationale", "policyGate"],
                    ),
                  },
                  [
                    "id",
                    "group",
                    "tags",
                    "language",
                    "query",
                    "changes",
                    "expected",
                  ],
                ),
              ),
              minItems: 1,
            },
          },
          ["id", "family", "partition", "requirements", "cases"],
        ),
        50,
      ),
      minItems: 1,
    },
  },
  ["version", "provenance", "projects"],
);
const validate = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
}).compile<Corpus>(schema);
export const corpusHash = (corpus: Corpus) =>
  createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
export function validateCorpus(value: unknown): asserts value is Corpus {
  if (!validate(value))
    throw new Error(
      `Invalid evaluation corpus: ${JSON.stringify(validate.errors)}`,
    );
  const projects = new Set<string>(),
    cases = new Set<string>();
  const families = new Map<string, string>(),
    groups = new Map<string, string>(),
    patches = new Map<string, string>();
  const members = new Set([
    "manager",
    "author",
    "backend-b",
    "frontend",
    "reviewer",
    "unrelated",
  ]);
  for (const project of value.projects) {
    if (projects.has(project.id)) throw new Error("Duplicate project identity");
    projects.add(project.id);
    if (
      families.has(project.family) &&
      families.get(project.family) !== project.partition
    )
      throw new Error("Requirement family crosses partitions");
    families.set(project.family, project.partition);
    const requirements = new Set(project.requirements.map((r) => r.key)),
      modules = new Set(project.modules?.map((m) => m.id) ?? []);
    if (
      requirements.size !== project.requirements.length ||
      modules.size !== (project.modules?.length ?? 0)
    )
      throw new Error("Duplicate requirement or module identity");
    for (const requirement of project.requirements)
      if (/[\r\n]/.test(requirement.text))
        throw new Error("Requirements must be source-linked single lines");
    for (const module of project.modules ?? [])
      if (
        module.requirements.some((key) => !requirements.has(key)) ||
        [...module.owners, ...(module.reviewers ?? [])].some(
          (member) => !members.has(member),
        )
      )
        throw new Error("Unknown module requirement or member");
    for (const edge of project.dependencies ?? [])
      if (!modules.has(edge.from) || !modules.has(edge.to))
        throw new Error("Unknown dependency module");
    for (const contract of project.contracts ?? [])
      if (!modules.has(contract.module))
        throw new Error("Unknown contract module");
    for (const item of project.cases) {
      if (cases.has(item.id)) throw new Error("Duplicate case identity");
      cases.add(item.id);
      if (
        !members.has(item.actor ?? "author") ||
        item.expected.audience?.some((member) => !members.has(member))
      )
        throw new Error("Unknown case member");
      if (item.expected.links.some((key) => !requirements.has(key)))
        throw new Error("Unknown gold requirement link");
      if (
        groups.has(item.group) &&
        groups.get(item.group) !== project.partition
      )
        throw new Error("Counterfactual group crosses partitions");
      groups.set(item.group, project.partition);
      const signature = createHash("sha256")
        .update(
          JSON.stringify(
            item.changes.map((c) => [c.before?.trim(), c.after?.trim()]),
          ),
        )
        .digest("hex");
      if (
        item.changes.length &&
        patches.has(signature) &&
        patches.get(signature) !== project.partition
      )
        throw new Error("Duplicate patch crosses partitions");
      patches.set(signature, project.partition);
      for (const change of item.changes)
        if (
          change.path.startsWith("/") ||
          /[\\:]|(^|\/)\.\.(\/|$)/.test(change.path)
        )
          throw new Error("Unsafe evidence path");
      for (const exception of item.exceptions ?? [])
        if (
          !requirements.has(exception.requirement) ||
          exception.authors.some((member) => !members.has(member))
        )
          throw new Error("Unknown exception scope");
    }
  }
}
export async function loadCorpus(file = resolve("evaluation/corpus.json")) {
  if ((await stat(file)).size > 2_000_000)
    throw new Error("Evaluation corpus exceeds its size limit");
  const corpus: unknown = JSON.parse(await readFile(file, "utf8"));
  validateCorpus(corpus);
  const seal = JSON.parse(
    await readFile(resolve(dirname(file), "seal.json"), "utf8"),
  );
  verifySeal(corpus, seal);
  return corpus;
}
export function verifySeal(corpus: Corpus, seal: any) {
  if (
    !seal ||
    seal.version !== 1 ||
    seal.humanReviewedCases !== 0 ||
    seal.corpusDigest !== corpusHash(corpus)
  )
    throw new Error(
      "Corpus seal mismatch; publish a reviewed new edition instead of silently changing labels",
    );
  for (const partition of ["development", "calibration", "heldout"]) {
    const projects = corpus.projects.filter(
      (project) => project.partition === partition,
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(projects))
      .digest("hex");
    if (
      seal.partitions?.[partition]?.digest !== digest ||
      seal.partitions[partition].projects !== projects.length ||
      seal.partitions[partition].cases !==
        projects.reduce((n, project) => n + project.cases.length, 0)
    )
      throw new Error("Partition seal mismatch");
  }
}
