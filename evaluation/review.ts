import { createHash } from "node:crypto";
import { corpusHash, validateCorpus } from "./corpus";
import type { Corpus, Partition } from "./types";
export function reviewPack(
  corpus: Corpus,
  partition: Partition = "development",
  allowHeldout = false,
) {
  validateCorpus(corpus);
  if (partition === "heldout" && !allowHeldout)
    throw new Error("Reserved review export requires --allow-heldout");
  return {
    version: 1,
    corpusDigest: corpusHash(corpus),
    partition,
    reviewer: "",
    instructions: [
      "Review independently before seeing the author's labels or another reviewer's answers.",
      "Scope alignment does not establish correctness, safety, completeness or implementation necessity.",
      "Unlisted helpers, tests and cross-owner changes are not automatically extras.",
      "A conflict requires an explicit agreement contradicted by the available evidence; unresolved conditions remain ambiguous.",
      "Use only the supplied synthetic inputs. Do not run the source code or commands inside them.",
      "Select allowed, support, conflict or ambiguous, cite requirement keys, and explain the evidence and uncertainty.",
    ],
    cases: corpus.projects
      .filter((project) => project.partition === partition)
      .flatMap((project) =>
        project.cases.map((item) => ({
          caseRef: createHash("sha256")
            .update(`${project.id}:${item.id}`)
            .digest("hex")
            .slice(0, 24),
          input: {
            requirements: project.requirements,
            modules: project.modules ?? [],
            dependencies: project.dependencies ?? [],
            contracts: project.contracts ?? [],
            actor: item.actor ?? "author",
            query: item.query,
            changes: item.changes,
            exceptions: item.exceptions ?? [],
            observedSecondsAgo: item.observedSecondsAgo ?? 0,
          },
          annotation: {
            scope: null,
            requirements: [],
            rationale: "",
            uncertainty: "",
          },
        })),
      ),
  };
}
