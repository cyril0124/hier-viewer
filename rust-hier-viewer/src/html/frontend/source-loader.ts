export type SourceKind = "instance" | "definition";

interface SourceNode { path: string; module: string; }
interface SourceTarget {
  kind: SourceKind;
  line: number;
  endLine: number;
  titleSuffix: string;
  locationLabel?: string;
}
interface SourceData { text: string; lines: string[]; lineOffsets?: number[] | null; }
interface Visibility { classList: Pick<DOMTokenList, "add" | "remove">; }
interface TextElement { textContent: string | null; }
interface RequestState {
  sourceNodeId: number | null;
  sourceTargetKind: SourceKind;
  sourceRequestToken: number;
  sourceAbortController: AbortController | null;
}

export interface SourceLoaderDependencies<N extends SourceNode, T extends SourceTarget, V, H extends Visibility> {
  state: RequestState;
  currentSourceView: V | null;
  getNode: (id: number) => N;
  preferredSourceTargetKind: (node: N) => SourceKind | null;
  buildSourceTarget: (node: N, kind: SourceKind | null) => T | null;
  resolveSourceUrl: (target: T) => string | null;
  sourceBookmarkKeyForTarget: (target: T) => string | null;
  sourceTitle: TextElement;
  sourceSubtitle: TextElement;
  sourceCode: Visibility & { innerHTML: string };
  openRawSourceLink: Visibility & { href: string };
  hoverCard: H;
  sourcePanel: Visibility;
  cancelScheduledHoverUpdate: () => void;
  clearUiAnnotationHoverTargetWithin: (container: H) => void;
  applySourcePanelWindowState: () => void;
  renderCurrentSourceView: (preferFocus: boolean) => void;
  formatSourceLocation: (target: T) => string;
  hideSourceLoadProgress: () => void;
  setSourceLoadProgress: (percent: number, stage: string, detail: string) => void;
  showSourceStatus: (message: string) => void;
  nextFrame: () => Promise<void>;
  loadFullSource: (target: T, signal: AbortSignal) => Promise<SourceData>;
  renderSourceRange: (node: N, target: T, data: SourceData, start: number, end: number, label: string, bookmarkKey: string | null) => void;
  renderSourceLines: (lines: string[], firstLine: number, focusStart: number, focusEnd: number, options: { bookmarkKey: string | null; text: string; textLength: number; lineOffsets: number[] | null | undefined; targetKind: SourceKind }) => void;
  emphasizeFocusedSourceRange: () => void;
  sourceRenderModeStatusSuffix: (view: V | null) => string;
  escapeHtml: (text: string) => string;
}

// The view property is shared with the reader; callers supply an accessor, not a snapshot.
export function createSourceLoader<N extends SourceNode, T extends SourceTarget, V, H extends Visibility>(deps: SourceLoaderDependencies<N, T, V, H>) {
  const {
    state, getNode, preferredSourceTargetKind, buildSourceTarget, resolveSourceUrl,
    sourceBookmarkKeyForTarget, sourceTitle, sourceSubtitle, sourceCode, openRawSourceLink,
    hoverCard, sourcePanel, cancelScheduledHoverUpdate, clearUiAnnotationHoverTargetWithin,
    applySourcePanelWindowState, renderCurrentSourceView, formatSourceLocation,
    hideSourceLoadProgress, setSourceLoadProgress, showSourceStatus, nextFrame,
    loadFullSource, renderSourceRange, renderSourceLines, emphasizeFocusedSourceRange,
    sourceRenderModeStatusSuffix, escapeHtml,
  } = deps;

  async function renderSource(nodeId: number, targetKind: SourceKind | null = null): Promise<void> {
    const node = getNode(nodeId);
    const resolvedKind = targetKind || preferredSourceTargetKind(node);
    const target = buildSourceTarget(node, resolvedKind);
    if (!target) {
      return;
    }
    cancelScheduledHoverUpdate();

    const focusStartLine = target.line || 1;
    const focusEndLine = target.endLine || focusStartLine;
    const sourceUrl = resolveSourceUrl(target);
    const bookmarkKey = sourceBookmarkKeyForTarget(target);

    sourceTitle.textContent = `${node.path} · ${target.titleSuffix}`;
    if (sourceUrl) {
      openRawSourceLink.href = sourceUrl;
      openRawSourceLink.classList.remove("hidden");
    } else {
      openRawSourceLink.href = "#";
      openRawSourceLink.classList.add("hidden");
    }

    hoverCard.classList.add("hidden");
    clearUiAnnotationHoverTargetWithin(hoverCard);
    state.sourceNodeId = nodeId;
    state.sourceTargetKind = target.kind;
    sourcePanel.classList.add("visible");
    applySourcePanelWindowState();
    const requestToken = state.sourceRequestToken + 1;
    state.sourceRequestToken = requestToken;
    if (state.sourceAbortController) {
      state.sourceAbortController.abort();
    }
    const controller = new AbortController();
    state.sourceAbortController = controller;
    deps.currentSourceView = null;
    renderCurrentSourceView(false);

    sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · loading full file...`;
    sourceCode.innerHTML = '<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">Loading...</span></div>';
    hideSourceLoadProgress();
    showSourceStatus(sourceUrl ? "Loading full file..." : "Source file unavailable.");

    if (!sourceUrl) {
      return;
    }

    try {
      await nextFrame();
      controller.signal.throwIfAborted();
      const sourceData = await loadFullSource(target, controller.signal);
      if (state.sourceNodeId !== nodeId || state.sourceRequestToken !== requestToken) {
        return;
      }
      const lineCount = sourceData.lines.length;
      setSourceLoadProgress(100, "Rendering source...", `${lineCount} lines ready`);
      await nextFrame();
      controller.signal.throwIfAborted();
      if (
        target.kind === "definition" &&
        Number.isFinite(target.line) &&
        Number.isFinite(target.endLine) &&
        target.endLine >= target.line
      ) {
        renderSourceRange(node, target, sourceData, target.line, target.endLine, "module definition", bookmarkKey);
        hideSourceLoadProgress();
        const shownLineCount = Math.max(0, target.endLine - target.line + 1);
        const modeSuffix = sourceRenderModeStatusSuffix(deps.currentSourceView);
        showSourceStatus(modeSuffix
          ? `Module source loaded (${shownLineCount} lines shown). ${modeSuffix}`
          : `Module source loaded (${shownLineCount} lines shown).`);
        return;
      }
      sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · full file`;
      hideSourceLoadProgress();
      renderSourceLines(sourceData.lines, 1, focusStartLine, focusEndLine, {
        bookmarkKey,
        text: sourceData.text,
        textLength: sourceData.text.length,
        lineOffsets: sourceData.lineOffsets,
        targetKind: target.kind,
      });
      await nextFrame();
      controller.signal.throwIfAborted();
      emphasizeFocusedSourceRange();
      await nextFrame();
      controller.signal.throwIfAborted();
      emphasizeFocusedSourceRange();
      const modeSuffix = sourceRenderModeStatusSuffix(deps.currentSourceView);
      showSourceStatus(modeSuffix
        ? `Full file loaded (${lineCount} lines). ${modeSuffix}`
        : `Full file loaded (${lineCount} lines).`);
    } catch (error) {
      if (state.sourceNodeId !== nodeId || state.sourceRequestToken !== requestToken) {
        return;
      }
      if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
        hideSourceLoadProgress();
        showSourceStatus("");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · source unavailable`;
      sourceCode.innerHTML = `<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">${escapeHtml(`Full file unavailable in this browser session (${message}). Use Open Raw or serve the bundle over HTTP.`)}</span></div>`;
      sourceCode.classList.remove("compact-mode");
      sourceCode.classList.remove("plain-mode");
      hideSourceLoadProgress();
      showSourceStatus("Full file load failed.");
    }
  }
  return renderSource;
}
