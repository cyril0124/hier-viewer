import type { CoverageLine, CoverageMetricDetail, CoverageSelection } from "./coverage-types.js";
import type { HierarchyNode, ViewerState } from "./types.js";
import type { SourceView } from "./main-types.js";

type LineExportEntry = { kind: "line"; row: CoverageLine; reportPath: string };
type DetailExportEntry = { kind: "detail"; data: CoverageMetricDetail; block: number; row: number };
export type CoverageExportEntry = LineExportEntry | DetailExportEntry;

interface ExportContext {
  selection: CoverageSelection;
  node: HierarchyNode;
  view: SourceView;
  verifiedReportSource?: string | null;
}

const METRIC_LABELS = { condition: "Condition", branch: "Branch", toggle: "Toggle", assert: "Assert" };
const DETAIL_METRICS = ["condition", "branch", "toggle", "assert"] as const;
const COPIED_MESSAGE = "Copied. Paste into your AI conversation.";

// A fence longer than any embedded backtick run keeps report and RTL text literal.
function formatCodeBlock(text: string, language = "text"): string {
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }
  const fence = "`".repeat(fenceLength);
  return `${fence}${language}\n${text}\n${fence}`;
}

function appendLineEntries(parts: string[], entries: readonly CoverageExportEntry[], sourceLines: Set<number>) {
  const lines = entries
    .filter((entry): entry is LineExportEntry => entry.kind === "line")
    .sort((left, right) => left.row.line - right.row.line);
  if (!lines.length) return;

  parts.push("## Line", "These report lines passed the viewer's source-path and source-text checks.");
  for (const { row, reportPath } of lines) {
    sourceLines.add(row.line);
    const observation = {
      line: row.line,
      covered: row.covered,
      total: row.total,
      excluded: row.excluded ?? false,
      reportPath,
      sourceText: row.sourceText,
    };
    parts.push(formatCodeBlock(JSON.stringify(observation, null, 2), "json"));
  }
}

function appendReportReferences(parts: string[], entry: DetailExportEntry, context: ExportContext, sourceLines: Set<number>) {
  const { node, verifiedReportSource } = context;
  const blocks = entry.data.blocks;

  // Several tables can share one expression. URG can also put LINE and EXPRESSION
  // in separate adjacent code blocks, so retain the entire preceding code group.
  let groupEnd = entry.block - 1;
  while (groupEnd >= 0 && blocks[groupEnd].kind !== "code") {
    groupEnd--;
  }
  if (groupEnd < 0) return;

  let groupStart = groupEnd;
  while (groupStart > 0 && blocks[groupStart - 1].kind === "code") {
    groupStart--;
  }

  const reportSourcePath = entry.data.filePath.replace(/\\/g, "/");
  const bundledSourcePath = node.definitionFilePath?.replace(/\\/g, "/");
  const sourcePathMatches = reportSourcePath === bundledSourcePath
    || reportSourcePath === verifiedReportSource?.replace(/\\/g, "/");
  for (let index = groupStart; index <= groupEnd; index++) {
    const reference = blocks[index];
    if (reference.kind !== "code") continue;

    parts.push("Report expression / reference:", formatCodeBlock(reference.text));
    const lineReference = /^\s*LINE\s+(\d+)/i.exec(reference.text);
    if (lineReference && sourcePathMatches) {
      sourceLines.add(Number(lineReference[1]));
    }
  }
}

function appendMetricEntries(parts: string[], entries: readonly CoverageExportEntry[], context: ExportContext, sourceLines: Set<number>) {
  for (const metric of DETAIL_METRICS) {
    const selected = entries
      .filter((entry): entry is DetailExportEntry => entry.kind === "detail" && entry.data.metric === metric)
      .sort((left, right) => left.block - right.block || left.row - right.row);
    if (!selected.length) continue;

    parts.push(`## ${METRIC_LABELS[metric]}`);
    let previousBlock = -1;
    for (const entry of selected) {
      const block = entry.data.blocks[entry.block];
      if (block.kind !== "table") continue;

      // Emit context once per table, followed by only its selected rows.
      if (previousBlock !== entry.block) {
        previousBlock = entry.block;
        parts.push(formatCodeBlock(`Detail source file: ${entry.data.filePath}\nTable: ${block.title ?? "Untitled"}`));
        appendReportReferences(parts, entry, context, sourceLines);
        const headers = block.rows
          .filter(row => row.header)
          .map(row => row.cells.join("\t"))
          .join("\n");
        parts.push("Original table headers:", formatCodeBlock(headers));
      }

      const row = block.rows[entry.row];
      const observation = { row: entry.row + 1, state: row.status, cells: row.cells };
      parts.push(formatCodeBlock(JSON.stringify(observation, null, 2), "json"));
    }
  }
}

function appendSourceContext(parts: string[], sourceLines: Set<number>, view: SourceView) {
  if (!sourceLines.size || !view.lines) return;

  parts.push("## Bundled source context", "Up to three surrounding lines per reference. This is the viewer's bundled RTL; it does not prove the simulation used this revision.");

  // Ranges use zero-based inclusive offsets into this source view. Merge them
  // before formatting so nearby selections do not repeat the same RTL lines.
  const ranges: { start: number; end: number }[] = [];
  for (const line of [...sourceLines].sort((left, right) => left - right)) {
    const index = line - view.firstLineNumber;
    const isWithinView = Number.isSafeInteger(index) && index >= 0 && index < view.lines.length;
    if (!isWithinView) continue;

    const start = Math.max(0, index - 3);
    const end = Math.min(view.lines.length - 1, index + 3);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  for (const { start, end } of ranges) {
    const numberedLines = [];
    for (let index = start; index <= end; index++) {
      numberedLines.push(`${index + view.firstLineNumber}: ${view.lines[index]}`);
    }
    parts.push(formatCodeBlock(numberedLines.join("\n")));
  }
  if (!ranges.length) {
    parts.push("The report references are outside the bundled source view; no source context was attached.");
  }
}

/** Entries must belong to this report, instance and source view. Line entries must
 * have passed source validation. Formatting is deterministic and does not mutate
 * the entries or fetch additional report/source data.
 */
export function formatCoverageExport(context: ExportContext, entries: readonly CoverageExportEntry[]): string {
  const { selection, node, view } = context;
  const scopeId = selection.display.mapping.scopeByNode[node.id];
  const scope = selection.display.summary.scopes[scopeId];
  const metadata = {
    report: selection.display.name,
    release: selection.display.summary.release,
    hierarchyInstance: node.path,
    coverageInstance: scope?.path ?? null,
    module: node.module,
    sourceFile: node.definitionFilePath ?? null,
    reportSourceFile: context.verifiedReportSource ?? null,
    selectedEntries: entries.length,
    subtreeMetrics: scope?.metrics ?? {},
  };
  const parts = [
    "# Coverage analysis selection",
    formatCodeBlock(JSON.stringify(metadata, null, 2), "json"),
    "Only explicitly selected observations are included below. Subtree metrics are reported totals, not totals of this selection. Line ratios count coverage points, not executions. Assert scores are not pass rates. Missing coverage alone does not establish an RTL defect.",
  ];

  const sourceLines = new Set<number>();
  appendLineEntries(parts, entries, sourceLines);
  appendMetricEntries(parts, entries, context, sourceLines);
  appendSourceContext(parts, sourceLines, view);
  return parts.join("\n\n") + "\n";
}

interface Dependencies {
  state: ViewerState;
  getSelection(): CoverageSelection | null;
  getNode(id: number): HierarchyNode;
  getView(): SourceView | null;
}

export function createCoverageExport(deps: Dependencies) {
  const countLabel = document.getElementById("coverage-export-count");
  const openButton = document.getElementById("coverage-export-open") as HTMLButtonElement | null;
  const clearButton = document.getElementById("coverage-export-clear") as HTMLButtonElement | null;
  const dialog = document.getElementById("coverage-export-dialog") as HTMLDialogElement | null;
  const previewText = document.getElementById("coverage-export-text") as HTMLTextAreaElement | null;
  const statusLabel = document.getElementById("coverage-export-status");
  const entries = new Map<string, CoverageExportEntry>();
  let selection: CoverageSelection | null = null;
  let nodeId: number | null = null;
  let view: SourceView | null = null;
  let verifiedReportSource: string | null = null;
  let generation = 0;

  function updateSelectionControls() {
    if (countLabel) countLabel.textContent = `${entries.size} selected`;
    if (openButton) openButton.disabled = entries.size === 0;
    if (clearButton) clearButton.disabled = entries.size === 0;

    for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-coverage-export-key]")) {
      checkbox.checked = entries.has(checkbox.dataset.coverageExportKey!);
    }
    for (const checkbox of document.querySelectorAll<HTMLInputElement>("[data-coverage-export-page]")) {
      const rows = checkbox.closest("table")!.querySelectorAll<HTMLInputElement>("tbody [data-coverage-export-key]");
      let selectedCount = 0;
      for (const row of rows) {
        if (row.checked) selectedCount++;
      }
      checkbox.checked = rows.length > 0 && selectedCount === rows.length;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < rows.length;
      checkbox.disabled = rows.length === 0;
    }
  }

  function reset() {
    entries.clear();
    generation++;
    dialog?.close();
    if (previewText) previewText.value = "";
    if (statusLabel) statusLabel.textContent = "";
    updateSelectionControls();
  }

  function setEntry(key: string, entry: CoverageExportEntry | null) {
    if (entry) {
      entries.set(key, entry);
    } else {
      entries.delete(key);
    }
  }

  function openPreview() {
    if (!selection || nodeId === null || !view || !entries.size || !dialog || !previewText) return;

    const context = { selection, node: deps.getNode(nodeId), view, verifiedReportSource };
    previewText.value = formatCoverageExport(context, [...entries.values()]);
    if (statusLabel) {
      statusLabel.textContent = `${entries.size} entries · ${previewText.value.length.toLocaleString()} characters`;
    }
    dialog.showModal();
  }

  function copyPreview() {
    if (!previewText?.value) return;

    // Clipboard promises can settle after the selected report or instance changes.
    const token = generation;
    const isCurrentPreview = () => generation === token && dialog?.open;
    const copyWithSelection = () => {
      if (!isCurrentPreview()) return;

      previewText.focus();
      previewText.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        // Keep the text selected for manual copying when the browser denies access.
      }
      if (statusLabel) {
        statusLabel.textContent = copied
          ? COPIED_MESSAGE
          : "Text selected. Press Ctrl+C or ⌘C, or use your device's Copy action.";
      }
    };

    // Ordinary HTTP deployments may not expose the Clipboard API at all.
    if (!navigator.clipboard?.writeText) {
      copyWithSelection();
      return;
    }
    void navigator.clipboard.writeText(previewText.value).then(() => {
      if (isCurrentPreview() && statusLabel) statusLabel.textContent = COPIED_MESSAGE;
    }).catch(copyWithSelection);
  }

  function downloadPreview() {
    if (!previewText?.value) return;

    const file = new Blob([previewText.value], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "coverage-selection.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  clearButton?.addEventListener("click", reset);
  openButton?.addEventListener("click", openPreview);
  document.getElementById("coverage-export-close")?.addEventListener("click", () => dialog?.close());
  document.getElementById("coverage-export-copy")?.addEventListener("click", copyPreview);
  document.getElementById("coverage-export-download")?.addEventListener("click", downloadPreview);

  return {
    setVerifiedSource(path: string | null) {
      verifiedReportSource = path;
    },
    has(key: string) {
      return entries.has(key);
    },
    // Keys identify original report rows, independent of filtering and pagination.
    // A null entry removes that key; adding an existing key replaces it.
    set(key: string, entry: CoverageExportEntry | null) {
      setEntry(key, entry);
      updateSelectionControls();
    },
    // Consume bulk selections before repainting controls, avoiding a DOM scan per row.
    setMany(values: Iterable<readonly [string, CoverageExportEntry | null]>) {
      for (const [key, entry] of values) {
        setEntry(key, entry);
      }
      updateSelectionControls();
    },
    sync() {
      const selected = deps.getSelection();
      const id = deps.state.sourceNodeId;
      const currentView = deps.getView();
      if (selected === selection && id === nodeId && currentView === view) return;

      // Shared source-file caches do not make selections transferable across instances.
      reset();
      verifiedReportSource = null;
      selection = selected;
      nodeId = id;
      view = currentView;
    },
    close() {
      reset();
      verifiedReportSource = null;
      selection = null;
      nodeId = null;
      view = null;
    },
  };
}

export type CoverageExporter = ReturnType<typeof createCoverageExport>;
