import type { Change } from "../src/shared/types";
export type Partition = "development" | "calibration" | "heldout";
export interface EvalCase {
  id: string;
  group: string;
  tags: string[];
  language: "en" | "hi-en";
  query: string;
  actor?: string;
  changes: Change[];
  exceptions?: {
    requirement: string;
    paths: string[];
    authors: string[];
    state: "active" | "expired" | "revoked" | "old-membership";
  }[];
  observedSecondsAgo?: number;
  expected: {
    scope: "allowed" | "support" | "conflict" | "ambiguous";
    links: string[];
    rationale: string;
    policyGate: boolean;
    audience?: string[];
  };
}
export interface EvalProject {
  id: string;
  family: string;
  partition: Partition;
  requirements: { key: string; text: string }[];
  modules?: {
    id: string;
    path: string;
    owners: string[];
    requirements: string[];
    reviewers?: string[];
  }[];
  dependencies?: { from: string; to: string }[];
  contracts?: { module: string; path: string; source: string }[];
  cases: EvalCase[];
}
export interface Corpus {
  version: 1;
  provenance: "synthetic-unreviewed";
  projects: EvalProject[];
}
