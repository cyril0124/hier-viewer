import type { SourceTargetKind, SourceRenderMode, TreemapArea } from "./types.js";

export interface BinaryReader {
  buffer: ArrayBuffer;
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  ensure(byteLength: number, label: string): void;
  readMagic(label: string): string;
  readU32(label: string): number;
  readOptionalU32(label: string): number | null;
  readU64Number(label: string): number;
  readOptionalU64Key(label: string): string | null;
  readU64Key(label: string): string;
  readStringTable(label: string): string[];
}

export interface SourceRange {
  start: number;
  end: number;
  matchIndex?: number;
}

export interface SourceSearchRecord extends SourceRange {
  lineNo: number;
  matchIndex: number;
}

export interface PlainSearchRecord extends SourceRange {
  lineNo: number;
}

export interface SourceSearch {
  regex: RegExp | null;
  error: string;
}

export interface PlainMetrics {
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
  width: number;
  height: number;
}

export interface SourceView {
  // Empty-source views only retain line positions and the bookmark key.
  lines?: string[];
  text?: string | null;
  textLength?: number | null;
  lineOffsets?: number[] | null;
  plainMetrics?: PlainMetrics | null;
  plainSearchMatches?: PlainSearchRecord[];
  searchMatchRecords?: SourceSearchRecord[];
  searchMatchRangesByLine?: Map<number, SourceSearchRecord[]>;
  searchSignature?: string | null;
  firstLineNumber: number;
  focusStartLine: number;
  focusEndLine: number;
  renderMode?: SourceRenderMode;
  virtualized?: boolean;
  lineHeight?: number | null;
  virtualStart?: number;
  virtualEnd?: number;
  targetKind?: SourceTargetKind;
  bookmarkKey: string | null;
}

export interface SourceLineOptions {
  text?: string;
  textLength?: number | null;
  lineOffsets?: number[] | null;
  targetKind?: SourceTargetKind;
  bookmarkKey?: string | null;
}

export interface CachedSource {
  text: string;
  lines: string[];
  lineOffsets: number[] | null;
}

export interface SearchHistorySession {
  index: number;
  draft: string;
}

export interface SearchHistoryOptions {
  apply?: (value: string, options: { fromHistory: boolean }) => void;
  getValue?: () => string;
}

export type Rect = TreemapArea["rect"];
export type AreaKind = TreemapArea["kind"];
export type LayoutArea = Omit<TreemapArea, "level">;
export interface LayoutItem {
  nodeId: number;
  kind: AreaKind;
  weight: number;
}

export type ClassicDivTree =
  | { nodeId: number; kind: "node"; size: number; children?: never }
  | { nodeId?: never; size: number; children: [ClassicDivTree, ClassicDivTree] };

export type AccurateDivTree =
  | { kind: "leaf"; areaKind: AreaKind; nodeId: number; size: number }
  | { kind: "pivot"; size: number; primary: AccurateDivTree; rest: AccurateDivTree | null }
  | { kind: "split"; size: number; children: [AccurateDivTree, AccurateDivTree] };

export interface ThemeVisuals {
  dark: boolean;
  canvasClassic: string;
  canvasAccurate: string;
  canvasBase: string;
  panel: string;
  text: string;
  textSoft: string;
  accents: string[];
  match: string;
  analysisRamp: string[];
}

export interface AnalysisBucketStyle {
  contentFill: string;
  contentStroke: string;
  shellFill: string;
  shellStroke: string;
  labelText: string;
  badgeText: string;
}

export interface LegendRow {
  shellFill: string;
  contentFill: string;
  label: string;
  meta: string;
  descendant?: boolean;
  filterKey?: string;
}
