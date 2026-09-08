import type { HierarchyNode } from "./types.js";

export type CoverageMetric = "line" | "condition" | "branch" | "toggle" | "assert";
export interface CoverageCounts {
  covered: number;
  total: number;
  excluded: number;
}
export type CoverageMetrics = Partial<Record<CoverageMetric, CoverageCounts>>;
export interface CoverageScope {
  name: string;
  path: string;
  parent: number | null;
  children: number[];
  metrics: CoverageMetrics;
}
export interface CoverageSummary {
  release: string;
  scopes: CoverageScope[];
  roots: number[];
  byPath: Map<string, number>;
}
export interface CoverageMapping {
  sourceRoot: number;
  targetRoot: number;
  scopeByNode: Int32Array;
  matched: number;
  unmatchedScopes: string[];
  unmatchedNodeIds: number[];
}
export interface CoverageFileSource {
  id: string;
  name: string;
  files: readonly string[];
  reportUrl?: string;
  readText(path: string, signal?: AbortSignal): Promise<string>;
  dispose?(): void;
}
export interface CoverageLine {
  line: number;
  covered: number;
  total: number;
  sourceText: string;
  excluded?: boolean;
}
export interface CoverageSourceLine {
  line: number;
  sourceText: string;
}
export interface CoverageLineData {
  instancePath: string;
  filePath: string;
  lines: CoverageLine[];
  sourceLines?: CoverageSourceLine[];
  totals: CoverageCounts;
  reportPath: string;
}
export interface CoverageDisplay {
  summary: CoverageSummary;
  mapping: CoverageMapping;
  metric: CoverageMetric | "off";
  filterMask?: number;
  name: string;
  reportUrl?: string;
}
export type CoverageDetailBlock =
  | { kind: "code"; text: string }
  | { kind: "table"; title?: string; rows: { cells: string[]; header: boolean; status: "covered" | "uncovered" | "failed" | "neutral" }[] };
export interface CoverageMetricDetail {
  instancePath: string;
  filePath: string;
  metric: Exclude<CoverageMetric, "line">;
  blocks: CoverageDetailBlock[];
}
export interface CoverageLineProvider {
  getMetricDetail(instancePath: string, moduleName: string, metric: Exclude<CoverageMetric, "line">, signal?: AbortSignal): Promise<CoverageMetricDetail | null>;
  getLineCoverage(instancePath: string, moduleName: string, signal?: AbortSignal): Promise<CoverageLineData | null>;
  clear(): void;
}
export interface CoverageSelection {
  source: CoverageFileSource;
  display: CoverageDisplay;
  report: CoverageLineProvider;
}
export type CoverageHierarchy = readonly Pick<HierarchyNode, "id" | "name" | "module" | "parent" | "children">[];
