import type {
  HierarchyNode,
  ViewerState,
  SourceTarget,
  SourceTargetKind,
  SourceRenderMode,
  SourceBookmark,
} from "./types.js";
import type {
  SourceRange,
  SourceSearchRecord,
  PlainSearchRecord,
  SourceSearch,
  SourceView,
  SourceLineOptions,
  CachedSource,
  SearchHistoryOptions,
  AreaKind,
} from "./main-types.js";

import { escapeHtml, formatLoadingBytes, nextFrame } from "./ui.js";
import { createSourceLoader } from "./source-loader.js";
import { createSourceCoverage } from "./source-coverage.js";
import type { CoverageSelection } from "./coverage-types.js";

export interface SourceReaderDependencies {
  getCoverage?: () => CoverageSelection | null;
  state: ViewerState;
  getNode: (id: number) => HierarchyNode;
  savePersistedState: () => void;
  scheduleUiAnnotations: () => void;
  cancelScheduledHoverUpdate: () => void;
  hoverCard: HTMLDivElement;
  clearUiAnnotationHoverTargetWithin: (container: Element | null) => void;
  updateHover: (nodeId: number | null, areaKind?: AreaKind, options?: { force?: boolean; }) => void;
  registerSearchHistoryInput: (input: HTMLInputElement | null, historyKey: string, options?: SearchHistoryOptions) => void;
}

export function createSourceReader(deps: SourceReaderDependencies) {
    const {
      state,
      getNode,
      savePersistedState,
      scheduleUiAnnotations,
      cancelScheduledHoverUpdate,
      hoverCard,
      clearUiAnnotationHoverTargetWithin,
      updateHover,
      registerSearchHistoryInput
    } = deps;

    const sourcePanel = (document.getElementById("source-panel") as HTMLElement);

    const sourceTitle = (document.getElementById("source-title") as HTMLDivElement);

    const sourceSubtitle = (document.getElementById("source-subtitle") as HTMLDivElement);

    const sourceStatus = (document.getElementById("source-status") as HTMLDivElement);

    const sourceLoadProgress = (document.getElementById("source-load-progress") as HTMLDivElement);

    const sourceLoadStage = (document.getElementById("source-load-stage") as HTMLDivElement);

    const sourceLoadDetail = (document.getElementById("source-load-detail") as HTMLDivElement);

    const sourceLoadBarFill = (document.getElementById("source-load-bar-fill") as HTMLDivElement);

    const sourceCode = (document.getElementById("source-code") as HTMLDivElement);

    const openRawSourceLink = (document.getElementById("open-raw-source-link") as HTMLAnchorElement);

    const toggleSourceFullscreenBtn = (document.getElementById("toggle-source-fullscreen-btn") as HTMLButtonElement);

    const closeSourceBtn = (document.getElementById("close-source-btn") as HTMLButtonElement);

    const sourceSearchModeSelect = (document.getElementById("source-search-mode-select") as HTMLSelectElement);

    const sourceSearchInput = (document.getElementById("source-search-input") as HTMLInputElement);

    const sourceSearchStatus = (document.getElementById("source-search-status") as HTMLDivElement);

    const sourceSearchPrevBtn = (document.getElementById("source-search-prev-btn") as HTMLButtonElement);

    const sourceSearchNextBtn = (document.getElementById("source-search-next-btn") as HTMLButtonElement);

    const sourceBookmarkList = (document.getElementById("source-bookmark-list") as HTMLDivElement);

    const appRoot = document.querySelector<HTMLElement>(".app");

    const sourceTextCache = new Map<string, CachedSource>();

    const SOURCE_SEARCH_INPUT_DEBOUNCE_MS = 120;

    const SOURCE_VIRTUALIZED_LINE_THRESHOLD = 320;

    const SOURCE_VIRTUALIZED_OVERSCAN_LINES = 120;

    const SOURCE_COMPACT_RENDER_INSTANCE_LINE_THRESHOLD = 2200;

    const SOURCE_COMPACT_RENDER_INSTANCE_CHAR_THRESHOLD = 320000;

    const SOURCE_COMPACT_RENDER_DEFINITION_LINE_THRESHOLD = 1800;

    const SOURCE_COMPACT_RENDER_DEFINITION_CHAR_THRESHOLD = 260000;

    const SOURCE_PLAIN_TEXT_INSTANCE_LINE_THRESHOLD = 500000;

    const SOURCE_PLAIN_TEXT_INSTANCE_CHAR_THRESHOLD = 40000000;

    const SOURCE_PLAIN_TEXT_DEFINITION_LINE_THRESHOLD = 300000;

    const SOURCE_PLAIN_TEXT_DEFINITION_CHAR_THRESHOLD = 24000000;

    let currentSourceView: SourceView | null = null;

    let sourceSearchMatchElements: HTMLElement[] = [];

    let sourceSearchInputTimer: ReturnType<typeof setTimeout> | null = null;

    const sourceLineHeightCache = new Map<string, number>();

    let sourceVirtualRenderQueued = false;

    let sourceVirtualRenderForce = false;

    const sourceCoverage = createSourceCoverage({
      state, getNode, sourceCode,
      getSelection: () => deps.getCoverage?.() ?? null,
      getView: () => currentSourceView,
      repaint: () => {
        if (!currentSourceView || currentSourceView.renderMode === "plain") return;
        if (currentSourceView.virtualized) scheduleSourceVirtualRender(true);
        else renderCurrentSourceView(false);
      },
      jumpToLine: (lineNo) => {
        if (!currentSourceView) return;
        if (currentSourceView.renderMode === "plain") {
          const index = lineNo - currentSourceView.firstLineNumber;
          const offsets = ensureSourceLineOffsets(currentSourceView);
          if (index >= 0 && index < offsets.length) selectPlainSourceRange(offsets[index], offsets[index] + currentSourceView.lines![index].length, true, lineNo);
        } else {
          scrollSourceLineIntoView(lineNo);
        }
      },
    });

    function applySourceSearchValue(value: string, options: { immediate?: boolean } = {}) {
      state.sourceSearch = value;
      sourceSearchInput.value = value;
      state.sourceSearchMatchIndex = 0;
      if (sourceSearchInputTimer !== null) {
        clearTimeout(sourceSearchInputTimer);
        sourceSearchInputTimer = null;
      }
      if (options.immediate) {
        renderCurrentSourceView(false);
        return;
      }
      sourceSearchInputTimer = setTimeout(() => {
        sourceSearchInputTimer = null;
        renderCurrentSourceView(false);
      }, SOURCE_SEARCH_INPUT_DEBOUNCE_MS);
    }

    function nodeHasInstanceSource(node: HierarchyNode) {
      return !!(node && node.filePath && node.sourceHref);
    }

    function nodeHasDefinitionSource(node: HierarchyNode) {
      return !!(node && node.definitionFilePath && node.definitionSourceHref);
    }

    function nodeHasAnySource(node: HierarchyNode) {
      return nodeHasInstanceSource(node) || nodeHasDefinitionSource(node);
    }

    function buildSourceTarget(node: HierarchyNode | null, kind: SourceTargetKind | null): SourceTarget | null {
      if (!node) {
        return null;
      }
      if (kind === "definition") {
        if (!nodeHasDefinitionSource(node)) {
          return null;
        }
        return {
          kind: "definition",
          filePath: node.definitionFilePath,
          sourceHref: node.definitionSourceHref,
          line: node.definitionLine || 1,
          column: node.definitionColumn || 1,
          endLine: node.definitionEndLine || node.definitionLine || 1,
          endColumn: node.definitionEndColumn || node.definitionColumn || 1,
          snippetText: node.definitionSnippetText || "",
          snippetStartLine: node.definitionSnippetStartLine || node.definitionLine || 1,
          snippetEndLine: node.definitionSnippetEndLine || node.definitionEndLine || node.definitionLine || 1,
          titleSuffix: "Module Source",
          locationLabel: "module source"
        };
      }
      if (!nodeHasInstanceSource(node)) {
        return null;
      }
      return {
        kind: "instance",
        filePath: node.filePath,
        sourceHref: node.sourceHref,
        line: node.line || 1,
        column: node.column || 1,
        endLine: node.endLine || node.line || 1,
        endColumn: node.endColumn || node.column || 1,
        snippetText: node.snippetText || "",
        snippetStartLine: node.snippetStartLine || node.line || 1,
        snippetEndLine: node.snippetEndLine || node.endLine || node.line || 1,
        titleSuffix: "Instantiation",
        locationLabel: "instantiation"
      };
    }

    function preferredSourceTargetKind(node: HierarchyNode) {
      if (nodeHasDefinitionSource(node)) {
        return "definition";
      }
      if (nodeHasInstanceSource(node)) {
        return "instance";
      }
      return null;
    }

    function normalizeSourceBookmarkPreview(text: unknown, useBlankFallback = false) {
      const compact = String(text ?? "").replace(/\s+/g, " ").trim();
      if (compact.length > 0) {
        return compact;
      }
      return useBlankFallback ? "(blank line)" : "";
    }

    function normalizeSourceBookmarkEntry(entry: unknown): SourceBookmark | null {
      if ((Number.isInteger as (value: unknown) => value is number)(entry) && entry > 0) {
        return { line: entry, label: "", preview: "" };
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const line = Number((entry as Record<string, unknown>).line);
      if (!(Number.isInteger as (value: unknown) => value is number)(line) || line <= 0) {
        return null;
      }
      return {
        line,
        label: typeof (entry as Record<string, unknown>).label === "string" ? ((entry as Record<string, unknown>).label as string).trim() : "",
        preview: typeof (entry as Record<string, unknown>).preview === "string"
          ? normalizeSourceBookmarkPreview((entry as Record<string, unknown>).preview, false)
          : ""
      };
    }

    function normalizeSourceBookmarks(raw: unknown): Record<string, SourceBookmark[]> {
      if (!raw || typeof raw !== "object") {
        return {};
      }
      const normalized: Record<string, SourceBookmark[]> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key !== "string" || key.length === 0 || !Array.isArray(value)) {
          continue;
        }
        const bookmarkMap = new Map<number, SourceBookmark>();
        for (const item of value as unknown[]) {
          const bookmark = normalizeSourceBookmarkEntry(item);
          if (!bookmark) {
            continue;
          }
          bookmarkMap.set(bookmark.line, bookmark);
        }
        const bookmarks = Array.from(bookmarkMap.values()).sort((left, right) => left.line - right.line);
        if (bookmarks.length) {
          normalized[key] = bookmarks;
        }
      }
      return normalized;
    }

    function sourceBookmarkKeyForTarget(target: SourceTarget | null) {
      if (!target) {
        return null;
      }
      if (target.sourceHref) {
        return `${target.kind}:href:${target.sourceHref}`;
      }
      if (target.filePath) {
        return `${target.kind}:path:${target.filePath}`;
      }
      return null;
    }

    function resolveSourceUrl(target: SourceTarget | null) {
      if (!target || !target.sourceHref) {
        return null;
      }
      try {
        return new URL(target.sourceHref, window.location.href).href;
      } catch (_) {
        return target.sourceHref;
      }
    }

    function showSourceStatus(message: string) {
      if (!message) {
        sourceStatus.textContent = "";
        sourceStatus.classList.add("hidden");
        return;
      }
      sourceStatus.textContent = message;
      sourceStatus.classList.remove("hidden");
    }

    function setSourceLoadProgress(percent: number, stage: string, detail = "") {
      if (!sourceLoadProgress) {
        return;
      }
      const clamped = Math.max(0, Math.min(100, percent));
      sourceLoadProgress.classList.remove("hidden");
      sourceLoadBarFill.style.width = `${clamped}%`;
      sourceLoadStage.textContent = stage;
      sourceLoadDetail.textContent = detail;
    }

    function hideSourceLoadProgress() {
      if (!sourceLoadProgress) {
        return;
      }
      sourceLoadProgress.classList.add("hidden");
      sourceLoadBarFill.style.width = "0%";
      sourceLoadStage.textContent = "Loading source...";
      sourceLoadDetail.textContent = "";
    }

    function buildSourceLineOffsets(lines: string[]) {
      const offsets = new Array<number>(lines.length);
      let cursor = 0;
      for (let index = 0; index < lines.length; index += 1) {
        offsets[index] = cursor;
        cursor += lines[index].length;
        if (index + 1 < lines.length) {
          cursor += 1;
        }
      }
      return offsets;
    }

    function ensureSourceLineOffsets(view: SourceView | null) {
      if (!view) {
        return [];
      }
      if (!Array.isArray(view.lineOffsets)) {
        view.lineOffsets = buildSourceLineOffsets(view.lines || []);
      }
      return view.lineOffsets;
    }

    function estimateSourceTextLength(view: SourceView | null) {
      if (!view) {
        return 0;
      }
      if ((Number.isInteger as (value: unknown) => value is number)(view.textLength) && view.textLength >= 0) {
        return view.textLength;
      }
      if (typeof view.text === "string") {
        view.textLength = view.text.length;
        return view.textLength;
      }
      const lines = Array.isArray(view.lines) ? view.lines : [];
      let total = lines.length > 0 ? lines.length - 1 : 0;
      for (let index = 0; index < lines.length; index += 1) {
        total += lines[index].length;
      }
      view.textLength = total;
      return total;
    }

    function ensureSourceText(view: SourceView | null) {
      if (!view) {
        return "";
      }
      if (typeof view.text !== "string") {
        view.text = Array.isArray(view.lines) ? view.lines.join("\n") : "";
      }
      view.textLength = view.text.length;
      return view.text;
    }

    function currentStructuredSourceMatches() {
      return currentSourceView?.searchMatchRecords || [];
    }

    function currentStructuredSourceMatchMap() {
      return currentSourceView?.searchMatchRangesByLine || new Map<number, SourceSearchRecord[]>();
    }

    function currentSourceBookmarkKey() {
      if (currentSourceView && currentSourceView.bookmarkKey) {
        return currentSourceView.bookmarkKey;
      }
      if (state.sourceNodeId === null || state.sourceNodeId === undefined) {
        return null;
      }
      return sourceBookmarkKeyForTarget(
        buildSourceTarget(getNode(state.sourceNodeId), state.sourceTargetKind || "instance")
      );
    }

    function currentSourceBookmarkLines() {
      return currentSourceBookmarks().map((bookmark) => bookmark.line);
    }

    function currentSourceBookmarks() {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return [];
      }
      return state.sourceBookmarksByFile[bookmarkKey] || [];
    }

    function findCurrentSourceBookmark(lineNo: number) {
      return currentSourceBookmarks().find((bookmark) => bookmark.line === lineNo) || null;
    }

    function sourceBookmarkPreviewForLine(lineNo: number) {
      if (!currentSourceView || !Array.isArray(currentSourceView.lines)) {
        return "";
      }
      const index = lineNo - currentSourceView.firstLineNumber;
      if (index < 0 || index >= currentSourceView.lines.length) {
        return "";
      }
      return normalizeSourceBookmarkPreview(currentSourceView.lines[index], true);
    }

    function syncCurrentSourceBookmarkPreviews() {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return;
      }
      const bookmarks = state.sourceBookmarksByFile[bookmarkKey];
      if (!Array.isArray(bookmarks) || !bookmarks.length) {
        return;
      }
      let changed = false;
      for (const bookmark of bookmarks) {
        const preview = sourceBookmarkPreviewForLine(bookmark.line);
        if (!preview || bookmark.preview === preview) {
          continue;
        }
        bookmark.preview = preview;
        changed = true;
      }
      if (changed) {
        savePersistedState();
      }
    }

    function sourceBookmarkDisplayTitle(bookmark: SourceBookmark) {
      return bookmark.label || bookmark.preview || `Line ${bookmark.line}`;
    }

    function sourceBookmarkDisplayMeta(bookmark: SourceBookmark) {
      if (bookmark.label) {
        return bookmark.preview
          ? `L${bookmark.line} · ${bookmark.preview}`
          : `Line ${bookmark.line}`;
      }
      return `Line ${bookmark.line}`;
    }

    function clearSourceBookmarkRename() {
      state.sourceBookmarkEditingKey = null;
      state.sourceBookmarkEditingLine = null;
      state.sourceBookmarkEditingDraft = "";
    }

    function startSourceBookmarkRename(lineNo: number) {
      const bookmark = findCurrentSourceBookmark(lineNo);
      if (!bookmark) {
        return;
      }
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey) {
        return;
      }
      state.sourceBookmarkEditingKey = bookmarkKey;
      state.sourceBookmarkEditingLine = lineNo;
      state.sourceBookmarkEditingDraft = bookmark.label;
      renderSourceBookmarkBar();
    }

    function commitSourceBookmarkRename(lineNo: number) {
      const bookmarkKey = currentSourceBookmarkKey();
      const bookmark = findCurrentSourceBookmark(lineNo);
      if (!bookmarkKey || !bookmark || state.sourceBookmarkEditingKey !== bookmarkKey) {
        clearSourceBookmarkRename();
        renderSourceBookmarkBar();
        return;
      }
      const label = state.sourceBookmarkEditingDraft.trim();
      bookmark.label = label;
      clearSourceBookmarkRename();
      renderSourceBookmarkBar();
      savePersistedState();
      showSourceStatus(label
        ? `Renamed bookmark at line ${lineNo}.`
        : `Cleared custom name for bookmark line ${lineNo}.`);
    }

    function setSourceLineBookmarkState(lineElement: HTMLElement | null, bookmarked: boolean) {
      if (!lineElement) {
        return;
      }
      lineElement.classList.toggle("bookmarked", bookmarked);
      const gutterButton = lineElement.querySelector<HTMLElement>(".source-lineno");
      if (!gutterButton) {
        return;
      }
      gutterButton.classList.toggle("bookmarked", bookmarked);
      gutterButton.setAttribute("aria-pressed", bookmarked ? "true" : "false");
      const lineNo = Number(lineElement.dataset.line);
      gutterButton.title = bookmarked
        ? `Remove bookmark at line ${lineNo}`
        : `Bookmark line ${lineNo}`;
    }

    function sourceBookmarkEmptyMessage() {
      if (currentSourceView?.renderMode === "plain") {
        return "Plain large-source mode disables inline line bookmarking.";
      }
      return "No bookmarks";
    }

    function renderSourceBookmarkBar() {
      if (!sourceBookmarkList) {
        return;
      }
      const bookmarkKey = currentSourceBookmarkKey();
      const lines = bookmarkKey ? currentSourceBookmarkLines() : [];
      sourceBookmarkList.innerHTML = "";
      if (!bookmarkKey) {
        sourceBookmarkList.innerHTML = '<span class="source-bookmark-empty">Bookmarks follow the current file.</span>';
        return;
      }
      const bookmarks = currentSourceBookmarks();
      if (!bookmarks.length) {
        sourceBookmarkList.innerHTML = `<span class="source-bookmark-empty">${escapeHtml(sourceBookmarkEmptyMessage())}</span>`;
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const bookmark of bookmarks) {
        const lineNo = bookmark.line;
        const isEditing = state.sourceBookmarkEditingKey === bookmarkKey
          && state.sourceBookmarkEditingLine === lineNo;
        const card = document.createElement("div");
        card.className = "source-bookmark-card";
        if (isEditing) {
          card.classList.add("editing");
        }
        if (isEditing) {
          const editor = document.createElement("div");
          editor.className = "source-bookmark-editor";

          const lineBadge = document.createElement("span");
          lineBadge.className = "source-bookmark-line";
          lineBadge.textContent = `L${lineNo}`;

          const input = document.createElement("input");
          input.type = "text";
          input.className = "source-bookmark-input";
          input.value = state.sourceBookmarkEditingDraft;
          input.placeholder = bookmark.preview || `Bookmark line ${lineNo}`;
          input.title = "Enter a custom bookmark name. Leave empty to show the source preview.";
          input.addEventListener("input", () => {
            state.sourceBookmarkEditingDraft = input.value;
          });
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitSourceBookmarkRename(lineNo);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              clearSourceBookmarkRename();
              renderSourceBookmarkBar();
            }
          });

          const saveButton = document.createElement("button");
          saveButton.type = "button";
          saveButton.className = "source-bookmark-save";
          saveButton.textContent = "Save";
          saveButton.addEventListener("click", () => {
            commitSourceBookmarkRename(lineNo);
          });

          const cancelButton = document.createElement("button");
          cancelButton.type = "button";
          cancelButton.className = "source-bookmark-cancel";
          cancelButton.textContent = "Cancel";
          cancelButton.addEventListener("click", () => {
            clearSourceBookmarkRename();
            renderSourceBookmarkBar();
          });

          const hint = document.createElement("div");
          hint.className = "source-bookmark-editor-hint";
          hint.textContent = bookmark.preview
            ? `Preview: ${bookmark.preview}`
            : `Preview unavailable for line ${lineNo} in the current inline view.`;

          editor.appendChild(lineBadge);
          editor.appendChild(input);
          editor.appendChild(saveButton);
          editor.appendChild(cancelButton);
          card.appendChild(editor);
          card.appendChild(hint);
          fragment.appendChild(card);
          continue;
        }

        const mainButton = document.createElement("button");
        mainButton.type = "button";
        mainButton.className = "source-bookmark-main";
        mainButton.title = `${sourceBookmarkDisplayTitle(bookmark)} · ${sourceBookmarkDisplayMeta(bookmark)}`;
        if (
          currentSourceView &&
          lineNo >= currentSourceView.focusStartLine &&
          lineNo <= currentSourceView.focusEndLine
        ) {
          card.classList.add("current");
          mainButton.classList.add("current");
        }
        mainButton.addEventListener("click", () => {
          focusSourceBookmark(lineNo);
        });

        const lineBadge = document.createElement("span");
        lineBadge.className = "source-bookmark-line";
        lineBadge.textContent = `L${lineNo}`;

        const copy = document.createElement("span");
        copy.className = "source-bookmark-copy";

        const title = document.createElement("span");
        title.className = "source-bookmark-title";
        title.textContent = sourceBookmarkDisplayTitle(bookmark);

        const meta = document.createElement("span");
        meta.className = "source-bookmark-meta";
        meta.textContent = sourceBookmarkDisplayMeta(bookmark);

        copy.appendChild(title);
        copy.appendChild(meta);
        mainButton.appendChild(lineBadge);
        mainButton.appendChild(copy);

        const actions = document.createElement("div");
        actions.className = "source-bookmark-actions";

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "source-bookmark-action";
        editButton.textContent = "Edit";
        editButton.title = `Rename bookmark at line ${lineNo}`;
        editButton.addEventListener("click", () => {
          startSourceBookmarkRename(lineNo);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "source-bookmark-action remove";
        deleteButton.textContent = "Del";
        deleteButton.title = `Delete bookmark at line ${lineNo}`;
        deleteButton.setAttribute("aria-label", `Delete bookmark at line ${lineNo}`);
        deleteButton.addEventListener("click", () => {
          toggleSourceBookmark(lineNo);
        });

        card.appendChild(mainButton);
        actions.appendChild(editButton);
        actions.appendChild(deleteButton);
        card.appendChild(actions);
        fragment.appendChild(card);
      }
      sourceBookmarkList.appendChild(fragment);
      if (state.sourceBookmarkEditingKey === bookmarkKey && state.sourceBookmarkEditingLine !== null) {
        const input = sourceBookmarkList.querySelector<HTMLInputElement>(".source-bookmark-input");
        if (input) {
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      }
    }

    function syncSourceBookmarksInView() {
      if (isPlainTextSourceView()) {
        renderSourceBookmarkBar();
        return;
      }
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      for (const lineElement of sourceCode.querySelectorAll<HTMLElement>(".source-line[data-line]")) {
        const lineNo = Number(lineElement.dataset.line);
        setSourceLineBookmarkState(lineElement, bookmarkSet.has(lineNo));
      }
      renderSourceBookmarkBar();
    }

    function focusSourceBookmark(lineNo: number) {
      if (isPlainTextSourceView()) {
        const range = plainSourceLineRange(currentSourceView, lineNo);
        if (!range) {
          showSourceStatus(`Bookmark line ${lineNo} is outside the current inline view. Use Open Raw for the full file.`);
          renderSourceBookmarkBar();
          return;
        }
        selectPlainSourceRange(range.start, range.end, true, lineNo);
        showSourceStatus(`Jumped to bookmark line ${lineNo}.`);
        renderSourceBookmarkBar();
        return;
      }
      for (const element of sourceCode.querySelectorAll<HTMLElement>(".source-line.bookmark-jump")) {
        element.classList.remove("bookmark-jump");
      }
      scrollSourceLineIntoView(lineNo, "center");
      const target = sourceCode.querySelector<HTMLElement>(`.source-line[data-line="${lineNo}"]`);
      if (!target) {
        showSourceStatus(`Bookmark line ${lineNo} is outside the current inline view. Use Open Raw for the full file.`);
        renderSourceBookmarkBar();
        return;
      }
      target.classList.add("bookmark-jump");
      showSourceStatus(`Jumped to bookmark line ${lineNo}.`);
      renderSourceBookmarkBar();
    }

    function clearSourceFocusJump() {
      for (const element of sourceCode.querySelectorAll<HTMLElement>(".source-line.focus-jump")) {
        element.classList.remove("focus-jump");
      }
    }

    function emphasizeFocusedSourceRange() {
      if (!currentSourceView) {
        return false;
      }
      const startLine = currentSourceView.focusStartLine || currentSourceView.firstLineNumber || 1;
      const endLine = Math.max(startLine, currentSourceView.focusEndLine || startLine);
      if (isPlainTextSourceView()) {
        const startRange = plainSourceLineRange(currentSourceView, startLine);
        const endRange = plainSourceLineRange(currentSourceView, endLine) || startRange;
        if (!startRange || !endRange) {
          return false;
        }
        selectPlainSourceRange(startRange.start, endRange.end, true, startLine);
        return true;
      }
      clearSourceFocusJump();
      scrollSourceLineIntoView(startLine, "center");
      let emphasized = false;
      const visibleEndLine = Math.min(endLine, startLine + 31);
      for (let lineNo = startLine; lineNo <= visibleEndLine; lineNo += 1) {
        const element = sourceCode.querySelector<HTMLElement>(`.source-line[data-line="${lineNo}"]`);
        if (!element) {
          continue;
        }
        element.classList.add("focus-jump");
        emphasized = true;
      }
      return emphasized;
    }

    function toggleSourceBookmark(lineNo: number) {
      const bookmarkKey = currentSourceBookmarkKey();
      if (!bookmarkKey || !(Number.isInteger as (value: unknown) => value is number)(lineNo) || lineNo <= 0) {
        return;
      }
      const bookmarks = [...currentSourceBookmarks()];
      const existingIndex = bookmarks.findIndex((bookmark) => bookmark.line === lineNo);
      if (existingIndex >= 0) {
        bookmarks.splice(existingIndex, 1);
        if (
          state.sourceBookmarkEditingKey === bookmarkKey
          && state.sourceBookmarkEditingLine === lineNo
        ) {
          clearSourceBookmarkRename();
        }
        showSourceStatus(`Removed bookmark at line ${lineNo}.`);
      } else {
        bookmarks.push({
          line: lineNo,
          label: "",
          preview: sourceBookmarkPreviewForLine(lineNo)
        });
        bookmarks.sort((left, right) => left.line - right.line);
        showSourceStatus(`Bookmarked line ${lineNo}.`);
      }
      if (bookmarks.length) {
        state.sourceBookmarksByFile[bookmarkKey] = bookmarks;
      } else {
        delete state.sourceBookmarksByFile[bookmarkKey];
      }
      syncSourceBookmarksInView();
      savePersistedState();
    }

    function buildSourceSearchRegExp() {
      const raw = state.sourceSearch.trim();
      if (!raw) {
        return { regex: null, error: "" };
      }
      try {
        if (state.sourceSearchMode === "regex") {
          return { regex: new RegExp(raw, "gi"), error: "" };
        }
        const fragment = raw
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*?")
          .replaceAll("?", ".");
        return { regex: new RegExp(fragment, "gi"), error: "" };
      } catch (error) {
        return {
          regex: null,
          error: `Invalid source search: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }

    function collectSourceSearchRanges(rawLine: string, searchRegex: RegExp | null) {
      if (!searchRegex || !rawLine.length) {
        return [];
      }
      const regex = new RegExp(searchRegex.source, searchRegex.flags);
      const ranges: SourceRange[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(rawLine)) !== null) {
        const text = match[0] || "";
        if (!text.length) {
          if (regex.lastIndex >= rawLine.length) {
            break;
          }
          regex.lastIndex += 1;
          continue;
        }
        const start = match.index ?? 0;
        ranges.push({ start, end: start + text.length });
        if (!regex.global) {
          break;
        }
      }
      return ranges;
    }

    function renderSourceStyledSlice(text: string, className: string | null) {
      if (!text) {
        return "";
      }
      const escaped = escapeHtml(text);
      return className ? `<span class="${className}">${escaped}</span>` : escaped;
    }

    function renderSourceSegmentWithSearch(text: string, segmentStart: number, className: string | null, matchRanges: SourceRange[]) {
      if (!text.length) {
        return "";
      }
      let out = "";
      let cursor = 0;
      const segmentEnd = segmentStart + text.length;
      for (const range of matchRanges) {
        if (range.end <= segmentStart) {
          continue;
        }
        if (range.start >= segmentEnd) {
          break;
        }
        const localStart = Math.max(range.start, segmentStart) - segmentStart;
        const localEnd = Math.min(range.end, segmentEnd) - segmentStart;
        if (localStart > cursor) {
          out += renderSourceStyledSlice(text.slice(cursor, localStart), className);
        }
        if (localEnd > localStart) {
          const matchIndex = (Number.isInteger as (value: unknown) => value is number)(range.matchIndex) ? range.matchIndex : null;
          const currentClass = matchIndex !== null && matchIndex === state.sourceSearchMatchIndex
            ? " current"
            : "";
          const matchAttr = matchIndex !== null ? ` data-match-index="${matchIndex}"` : "";
          out += `<mark class="source-find-hit${currentClass}"${matchAttr}>${renderSourceStyledSlice(text.slice(localStart, localEnd), className)}</mark>`;
        }
        cursor = localEnd;
      }
      if (cursor < text.length) {
        out += renderSourceStyledSlice(text.slice(cursor), className);
      }
      return out;
    }

    function highlightVerilogLine(rawLine: string, matchRanges: SourceRange[] = []) {
      const pattern = /"(?:\\.|[^"])*"|\/\/.*|`[A-Za-z_][A-Za-z0-9_]*|\b(?:alias|always|always_comb|always_ff|always_latch|assign|assume|assert|automatic|before|begin|bit|break|byte|case|casex|casez|checker|class|clocking|const|constraint|continue|cover|covergroup|coverpoint|cross|default|disable|do|else|end|endcase|endchecker|endclass|endclocking|endfunction|endgenerate|endgroup|endinterface|endmodule|endpackage|endprogram|endproperty|endsequence|endtask|enum|event|export|extends|final|for|force|foreach|forever|fork|function|genvar|generate|if|ignore_bins|illegal_bins|implements|import|inout|input|inside|int|integer|interface|join|join_any|join_none|local|localparam|logic|longint|modport|module|new|null|output|package|parameter|priority|program|property|protected|pure|rand|randc|randcase|randsequence|real|realtime|ref|reg|release|repeat|return|sequence|shortint|shortreal|signed|solve|static|string|struct|super|supply0|supply1|task|this|time|tri|typedef|union|unique|unsigned|uwire|var|virtual|void|wait|while|wire|with|within|wor|wand)\b|\b\d+(?:'[bdhoBDHO][0-9a-fA-F_xXzZ?]+)?\b/g;
      let out = "";
      let last = 0;
      for (const match of rawLine.matchAll(pattern)) {
        const index = match.index ?? 0;
        out += renderSourceSegmentWithSearch(
          rawLine.slice(last, index),
          last,
          null,
          matchRanges
        );
        const token = match[0];
        let cls = "tok-keyword";
        if (token.startsWith("//")) {
          cls = "tok-comment";
        } else if (token.startsWith("\"")) {
          cls = "tok-string";
        } else if (token.startsWith("`")) {
          cls = "tok-directive";
        } else if (/^\d/.test(token)) {
          cls = "tok-number";
        }
        out += renderSourceSegmentWithSearch(token, index, cls, matchRanges);
        last = index + token.length;
      }
      out += renderSourceSegmentWithSearch(
        rawLine.slice(last),
        last,
        null,
        matchRanges
      );
      return out.length ? out : "&nbsp;";
    }

    function updateSourceSearchStatus() {
      const activeQuery = state.sourceSearch.trim();
      const totalMatches = currentSourceSearchTotalMatches();
      sourceSearchStatus.classList.toggle("error", !!state.sourceSearchError);
      if (state.sourceSearchError) {
        sourceSearchStatus.textContent = state.sourceSearchError;
      } else if (!activeQuery) {
        sourceSearchStatus.textContent = "Search current view";
      } else if (!totalMatches) {
        sourceSearchStatus.textContent = "0 matches";
      } else {
        sourceSearchStatus.textContent = `${state.sourceSearchMatchIndex + 1}/${totalMatches} matches`;
      }
      const disabled = !totalMatches || !!state.sourceSearchError;
      sourceSearchPrevBtn.disabled = disabled;
      sourceSearchNextBtn.disabled = disabled;
    }

    function isPlainTextSourceView() {
      return !!(currentSourceView && currentSourceView.renderMode === "plain");
    }

    function plainSourceTextarea() {
      return sourceCode.querySelector<HTMLTextAreaElement>(".source-plain-text");
    }

    function plainSourceLineRange(view: SourceView | null, lineNo: number) {
      if (!view || !Array.isArray(view.lines)) {
        return null;
      }
      const lineOffsets = ensureSourceLineOffsets(view);
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines.length) {
        return null;
      }
      const start = lineOffsets[index];
      const end = start + view.lines[index].length;
      return { start, end, index };
    }

    function measurePlainSourceMetrics(view: SourceView | null, textarea: HTMLTextAreaElement | null) {
      if (!view || !textarea) {
        return null;
      }
      const cached = view.plainMetrics;
      if (
        cached
        && cached.width === textarea.clientWidth
        && cached.height === textarea.clientHeight
      ) {
        return cached;
      }
      const style = window.getComputedStyle(textarea);
      const metrics = {
        lineHeight: Number.parseFloat(style.lineHeight) || 21.33,
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        width: textarea.clientWidth,
        height: textarea.clientHeight,
      };
      view.plainMetrics = metrics;
      return metrics;
    }

    function plainSourceScrollTopForLine(view: SourceView | null, textarea: HTMLTextAreaElement | null, lineNo: number, block: ScrollLogicalPosition = "center") {
      if (!view || !textarea) {
        return null;
      }
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines!.length) {
        return null;
      }
      const metrics = measurePlainSourceMetrics(view, textarea);
      if (!metrics) {
        return null;
      }
      const viewportHeight = Math.max(
        1,
        textarea.clientHeight - metrics.paddingTop - metrics.paddingBottom,
      );
      const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
      const lineTop = metrics.paddingTop + index * metrics.lineHeight;
      if (block === "start") {
        return Math.max(0, Math.min(maxScrollTop, lineTop));
      }
      if (block === "nearest") {
        const currentTop = textarea.scrollTop;
        const currentBottom = currentTop + textarea.clientHeight;
        const lineBottom = lineTop + metrics.lineHeight;
        if (lineTop >= currentTop && lineBottom <= currentBottom) {
          return currentTop;
        }
      }
      const centered = lineTop - Math.max(0, (viewportHeight - metrics.lineHeight) / 2);
      return Math.max(0, Math.min(maxScrollTop, centered));
    }

    function scrollPlainSourceLineIntoView(lineNo: number, block: ScrollLogicalPosition = "center") {
      const textarea = plainSourceTextarea();
      if (!textarea || !currentSourceView) {
        return;
      }
      const nextScrollTop = plainSourceScrollTopForLine(
        currentSourceView,
        textarea,
        lineNo,
        block,
      );
      if (nextScrollTop === null) {
        return;
      }
      textarea.scrollTop = nextScrollTop;
    }

    function selectPlainSourceRange(start: number, end: number, scrollIntoView: boolean = true, lineNo: number | null = null) {
      const textarea = plainSourceTextarea();
      if (!textarea) {
        return;
      }
      textarea.setSelectionRange(start, end);
      if (scrollIntoView && (Number.isInteger as (value: unknown) => value is number)(lineNo)) {
        scrollPlainSourceLineIntoView(lineNo, "center");
      }
    }

    function buildPlainSourceSearchMatches(view: SourceView | null, search: SourceSearch) {
      if (!view || !search.regex || search.error) {
        return [];
      }
      const lineOffsets = ensureSourceLineOffsets(view);
      const matches: PlainSearchRecord[] = [];
      for (let index = 0; index < view.lines!.length; index += 1) {
        const ranges: SourceRange[] = collectSourceSearchRanges(view.lines![index], search.regex);
        if (!ranges.length) {
          continue;
        }
        const lineOffset = lineOffsets[index];
        const lineNo = view.firstLineNumber + index;
        for (const range of ranges) {
          matches.push({
            lineNo,
            start: lineOffset + range.start,
            end: lineOffset + range.end,
          });
        }
      }
      return matches;
    }

    function buildStructuredSourceSearchMatches(view: SourceView | null, search: SourceSearch) {
      const records: SourceSearchRecord[] = [];
      const rangesByLine = new Map<number, SourceSearchRecord[]>();
      if (!view || !search.regex || search.error) {
        return { records, rangesByLine };
      }
      for (let index = 0; index < view.lines!.length; index += 1) {
        const ranges: SourceRange[] = collectSourceSearchRanges(view.lines![index], search.regex);
        if (!ranges.length) {
          continue;
        }
        const lineNo = view.firstLineNumber + index;
        const enrichedRanges = new Array<SourceSearchRecord>(ranges.length);
        for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
          const range = ranges[rangeIndex];
          const enriched = {
            start: range.start,
            end: range.end,
            lineNo,
            matchIndex: records.length,
          };
          records.push(enriched);
          enrichedRanges[rangeIndex] = enriched;
        }
        rangesByLine.set(lineNo, enrichedRanges);
      }
      return { records, rangesByLine };
    }

    function sourceSearchSignature(search: SourceSearch | null) {
      if (!search) {
        return "";
      }
      if (search.error) {
        return `error:${search.error}`;
      }
      if (!search.regex) {
        return "";
      }
      return `${search.regex.source}/${search.regex.flags}`;
    }

    function ensureStructuredSourceSearchData(view: SourceView | null, search: SourceSearch) {
      if (!view) {
        return;
      }
      const signature = sourceSearchSignature(search);
      if (view.searchSignature === signature) {
        return;
      }
      const { records, rangesByLine } = buildStructuredSourceSearchMatches(view, search);
      view.searchSignature = signature;
      view.searchMatchRecords = records;
      view.searchMatchRangesByLine = rangesByLine;
    }

    function currentSourceSearchTotalMatches() {
      return isPlainTextSourceView()
        ? (currentSourceView?.plainSearchMatches || []).length
        : currentStructuredSourceMatches().length;
    }

    function applyCurrentSourceSearchSelection(scrollIntoView = true) {
      if (isPlainTextSourceView()) {
        const plainMatches = currentSourceView?.plainSearchMatches || [];
        if (
          state.sourceSearchMatchIndex < 0 ||
          state.sourceSearchMatchIndex >= plainMatches.length
        ) {
          updateSourceSearchStatus();
          return;
        }
        const current = plainMatches[state.sourceSearchMatchIndex];
        selectPlainSourceRange(current.start, current.end, scrollIntoView, current.lineNo);
        updateSourceSearchStatus();
        return;
      }
      clearVisibleSourceSearchSelection();
      const structuredMatches = currentStructuredSourceMatches();
      if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= structuredMatches.length
      ) {
        updateSourceSearchStatus();
        return;
      }
      const current = structuredMatches[state.sourceSearchMatchIndex];
      if (scrollIntoView) {
        scrollSourceLineIntoView(current.lineNo, "center");
      }
      const currentElement = sourceCode.querySelector<HTMLElement>(`.source-find-hit[data-match-index="${current.matchIndex}"]`);
      if (currentElement) {
        currentElement.classList.add("current");
        currentElement.closest<HTMLElement>(".source-line")?.classList.add("search-current");
        if (scrollIntoView) {
          currentElement.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
      updateSourceSearchStatus();
    }

    function moveSourceSearch(delta: number) {
      const total = currentSourceSearchTotalMatches();
      if (!total) {
        return;
      }
      const current = state.sourceSearchMatchIndex < 0 ? 0 : state.sourceSearchMatchIndex;
      state.sourceSearchMatchIndex = (current + delta + total) % total;
      applyCurrentSourceSearchSelection(true);
    }

    function shouldUseCompactSourceRender(view: SourceView | null) {
      if (!view) {
        return false;
      }
      const textLength = estimateSourceTextLength(view);
      if (view.targetKind === "definition") {
        return view.lines!.length >= SOURCE_COMPACT_RENDER_DEFINITION_LINE_THRESHOLD
          || textLength >= SOURCE_COMPACT_RENDER_DEFINITION_CHAR_THRESHOLD;
      }
      return view.lines!.length >= SOURCE_COMPACT_RENDER_INSTANCE_LINE_THRESHOLD
        || textLength >= SOURCE_COMPACT_RENDER_INSTANCE_CHAR_THRESHOLD;
    }

    function shouldUsePlainTextSourceRender(view: SourceView | null) {
      if (!view) {
        return false;
      }
      const textLength = estimateSourceTextLength(view);
      if (view.targetKind === "definition") {
        return view.lines!.length >= SOURCE_PLAIN_TEXT_DEFINITION_LINE_THRESHOLD
          || textLength >= SOURCE_PLAIN_TEXT_DEFINITION_CHAR_THRESHOLD;
      }
      return view.lines!.length >= SOURCE_PLAIN_TEXT_INSTANCE_LINE_THRESHOLD
        || textLength >= SOURCE_PLAIN_TEXT_INSTANCE_CHAR_THRESHOLD;
    }

    function resolveSourceRenderMode(view: SourceView | null) {
      if (!view) {
        return "full";
      }
      if (shouldUsePlainTextSourceRender(view)) {
        return "plain";
      }
      if (shouldUseCompactSourceRender(view)) {
        return "compact";
      }
      return "full";
    }

    function renderSourceLineContent(line: string, matchRanges: SourceRange[]) {
      return highlightVerilogLine(line, matchRanges);
    }

    function shouldVirtualizeSourceRender(view: SourceView | null) {
      return !!(view && view.lines!.length >= SOURCE_VIRTUALIZED_LINE_THRESHOLD);
    }

    function buildSourceLineHtml(line: string, lineNo: number, focusStartLine: number, focusEndLine: number, bookmarkSet: Set<number>, matchRanges: SourceRange[], renderMode: SourceRenderMode = "full") {
      const classes = ["source-line"];
      const coverageClass = sourceCoverage.lineClass(lineNo);
      if (coverageClass) classes.push(coverageClass);
      if (renderMode === "compact") {
        classes.push("compact");
      }
      if (lineNo >= focusStartLine && lineNo <= focusEndLine) {
        classes.push("active");
      }
      if (matchRanges.length > 0) {
        classes.push("search-match");
      }
      if (matchRanges.some((range) => range.matchIndex === state.sourceSearchMatchIndex)) {
        classes.push("search-current");
      }
      if (bookmarkSet.has(lineNo)) {
        classes.push("bookmarked");
      }
      const bookmarkTitle = bookmarkSet.has(lineNo)
        ? `Remove bookmark at line ${lineNo}`
        : `Bookmark line ${lineNo}`;
      return `<div class="${classes.join(" ")}" data-line="${lineNo}"><button class="source-lineno${bookmarkSet.has(lineNo) ? " bookmarked" : ""}" type="button" data-line="${lineNo}" aria-pressed="${bookmarkSet.has(lineNo) ? "true" : "false"}" title="${bookmarkTitle}"><span class="source-bookmark-dot" aria-hidden="true"></span><span class="source-lineno-value">${lineNo}</span></button>${sourceCoverage.cell(lineNo)}<span class="source-code-text">${renderSourceLineContent(line, matchRanges)}</span></div>`;
    }

    function measureSourceLineHeight(renderMode: SourceRenderMode | undefined) {
      const cacheKey = renderMode === "compact" ? "compact" : "full";
      const cached = sourceLineHeightCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const probe = document.createElement("div");
      probe.className = renderMode === "compact" ? "source-line compact" : "source-line";
      probe.dataset.line = "1";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.style.contentVisibility = "visible";
      probe.style.contain = "none";
      probe.style.inset = "0 auto auto 0";
      if (renderMode === "compact") {
        probe.innerHTML = '<span class="source-code-text"><span class="tok-keyword">module</span> probe;</span>';
      } else {
        probe.innerHTML = '<button class="source-lineno" type="button" data-line="1" aria-pressed="false"><span class="source-bookmark-dot" aria-hidden="true"></span><span class="source-lineno-value">1</span></button><span class="source-code-text"><span class="tok-keyword">module</span> probe;</span>';
      }
      sourceCode.appendChild(probe);
      const height = Math.max(20, Math.ceil(probe.getBoundingClientRect().height || 22));
      probe.remove();
      sourceLineHeightCache.set(cacheKey, height);
      return height;
    }

    function sourceLineIndex(view: SourceView | null, lineNo: number) {
      if (!view) {
        return -1;
      }
      const index = lineNo - view.firstLineNumber;
      if (index < 0 || index >= view.lines!.length) {
        return -1;
      }
      return index;
    }

    function sourceScrollTopForLine(view: SourceView | null, lineNo: number, block: ScrollLogicalPosition = "center") {
      const index = sourceLineIndex(view, lineNo);
      if (index < 0) {
        return null;
      }
      const lineHeight = view!.lineHeight || measureSourceLineHeight(view!.renderMode);
      view!.lineHeight = lineHeight;
      const viewportHeight = Math.max(sourceCode.clientHeight, lineHeight * 10);
      const maxScrollTop = Math.max(0, view!.lines!.length * lineHeight - viewportHeight);
      const lineTop = index * lineHeight;
      if (block === "start") {
        return Math.min(maxScrollTop, lineTop);
      }
      if (block === "nearest") {
        const currentTop = sourceCode.scrollTop;
        const currentBottom = currentTop + viewportHeight;
        const lineBottom = lineTop + lineHeight;
        if (lineTop >= currentTop && lineBottom <= currentBottom) {
          return currentTop;
        }
      }
      const centered = lineTop - Math.max(0, (viewportHeight - lineHeight) / 2);
      return Math.max(0, Math.min(maxScrollTop, centered));
    }

    function clearVisibleSourceSearchSelection() {
      for (const element of sourceCode.querySelectorAll<HTMLElement>(".source-find-hit.current")) {
        element.classList.remove("current");
      }
      for (const lineElement of sourceCode.querySelectorAll<HTMLElement>(".source-line.search-current")) {
        lineElement.classList.remove("search-current");
      }
    }

    function applyVisibleSourceSearchSelection() {
      clearVisibleSourceSearchSelection();
      const matches = currentStructuredSourceMatches();
      if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= matches.length
      ) {
        return;
      }
      const current = matches[state.sourceSearchMatchIndex];
      const currentElement = sourceCode.querySelector<HTMLElement>(`.source-find-hit[data-match-index="${current.matchIndex}"]`);
      if (!currentElement) {
        return;
      }
      currentElement.classList.add("current");
      currentElement.closest<HTMLElement>(".source-line")?.classList.add("search-current");
    }

    function ensureSourceVirtualElements() {
      let shell = sourceCode.querySelector<HTMLElement>(".source-virtual-shell");
      let topSpacer = sourceCode.querySelector<HTMLElement>(".source-virtual-spacer-top");
      let content = sourceCode.querySelector<HTMLElement>(".source-virtual-content");
      let bottomSpacer = sourceCode.querySelector<HTMLElement>(".source-virtual-spacer-bottom");
      if (shell && topSpacer && content && bottomSpacer) {
        return { shell, topSpacer, content, bottomSpacer };
      }
      shell = document.createElement("div");
      shell.className = "source-virtual-shell";
      topSpacer = document.createElement("div");
      topSpacer.className = "source-virtual-spacer source-virtual-spacer-top";
      content = document.createElement("div");
      content.className = "source-virtual-content";
      bottomSpacer = document.createElement("div");
      bottomSpacer.className = "source-virtual-spacer source-virtual-spacer-bottom";
      shell.appendChild(topSpacer);
      shell.appendChild(content);
      shell.appendChild(bottomSpacer);
      sourceCode.replaceChildren(shell);
      return { shell, topSpacer, content, bottomSpacer };
    }

    function renderVisibleVirtualSourceWindow(force = false) {
      const view = currentSourceView;
      if (!view || !view.virtualized) {
        return;
      }
      const { shell, topSpacer, content, bottomSpacer } = ensureSourceVirtualElements();
      const lineHeight = view.lineHeight || measureSourceLineHeight(view.renderMode);
      view.lineHeight = lineHeight;
      shell.style.setProperty("--source-line-height", `${lineHeight}px`);
      const viewportHeight = Math.max(sourceCode.clientHeight, lineHeight * 12);
      const startIndex = Math.max(0, Math.floor(sourceCode.scrollTop / lineHeight) - SOURCE_VIRTUALIZED_OVERSCAN_LINES);
      const endIndex = Math.min(
        view.lines!.length,
        Math.ceil((sourceCode.scrollTop + viewportHeight) / lineHeight) + SOURCE_VIRTUALIZED_OVERSCAN_LINES,
      );
      if (!force && startIndex === view.virtualStart && endIndex === view.virtualEnd) {
        applyVisibleSourceSearchSelection();
        return;
      }
      view.virtualStart = startIndex;
      view.virtualEnd = endIndex;
      topSpacer.style.height = `${startIndex * lineHeight}px`;
      bottomSpacer.style.height = `${Math.max(0, (view.lines!.length - endIndex) * lineHeight)}px`;
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      const matchMap = currentStructuredSourceMatchMap();
      let html = "";
      for (let index = startIndex; index < endIndex; index += 1) {
        const lineNo = view.firstLineNumber + index;
        html += buildSourceLineHtml(
          view.lines![index],
          lineNo,
          view.focusStartLine,
          view.focusEndLine,
          bookmarkSet,
          matchMap.get(lineNo) || [],
          view.renderMode,
        );
      }
      content.innerHTML = html;
      sourceSearchMatchElements = Array.from(content.querySelectorAll<HTMLElement>(".source-find-hit"));
      syncSourceBookmarksInView();
      applyVisibleSourceSearchSelection();
    }

    function scheduleSourceVirtualRender(force = false) {
      if (!currentSourceView?.virtualized) {
        return;
      }
      sourceVirtualRenderForce = sourceVirtualRenderForce || force;
      if (sourceVirtualRenderQueued) {
        return;
      }
      sourceVirtualRenderQueued = true;
      requestAnimationFrame(() => {
        sourceVirtualRenderQueued = false;
        const forceNow = sourceVirtualRenderForce;
        sourceVirtualRenderForce = false;
        renderVisibleVirtualSourceWindow(forceNow);
      });
    }

    function scrollSourceLineIntoView(lineNo: number, block: ScrollLogicalPosition = "center") {
      if (!currentSourceView) {
        return;
      }
      if (currentSourceView.virtualized) {
        const nextScrollTop = sourceScrollTopForLine(currentSourceView, lineNo, block);
        if (nextScrollTop === null) {
          return;
        }
        sourceCode.scrollTop = nextScrollTop;
        renderVisibleVirtualSourceWindow(true);
        return;
      }
      const focusElement = sourceCode.querySelector<HTMLElement>(`[data-line="${lineNo}"]`);
      if (focusElement) {
        focusElement.scrollIntoView({ block, inline: "nearest" });
      }
    }

    function finalizeRenderedSource(preferFocusLine: boolean) {
      if (isPlainTextSourceView()) {
        sourceSearchMatchElements = [];
        currentSourceView!.plainSearchMatches = buildPlainSourceSearchMatches(
          currentSourceView,
          buildSourceSearchRegExp(),
        );
        if (!currentSourceView!.plainSearchMatches.length) {
          state.sourceSearchMatchIndex = -1;
        } else if (
          state.sourceSearchMatchIndex < 0 ||
          state.sourceSearchMatchIndex >= currentSourceView!.plainSearchMatches.length
        ) {
          state.sourceSearchMatchIndex = 0;
        }
        syncSourceBookmarksInView();
        if (state.sourceSearch.trim().length > 0 && currentSourceView!.plainSearchMatches.length > 0) {
          applyCurrentSourceSearchSelection(true);
          return;
        }
        updateSourceSearchStatus();
        if (preferFocusLine && currentSourceView) {
          emphasizeFocusedSourceRange();
        }
        return;
      }
      const totalMatches = currentStructuredSourceMatches().length;
      clearSourceFocusJump();
      if (!totalMatches) {
        state.sourceSearchMatchIndex = -1;
      } else if (
        state.sourceSearchMatchIndex < 0 ||
        state.sourceSearchMatchIndex >= totalMatches
      ) {
        state.sourceSearchMatchIndex = 0;
      }

      const shouldFocusSearch = state.sourceSearch.trim().length > 0 && totalMatches > 0;
      syncSourceBookmarksInView();
      if (shouldFocusSearch) {
        applyCurrentSourceSearchSelection(true);
        return;
      }
      updateSourceSearchStatus();
      if (preferFocusLine && currentSourceView) {
        emphasizeFocusedSourceRange();
        return;
      }
      applyVisibleSourceSearchSelection();
    }

    function renderCurrentSourceView(preferFocusLine: boolean = true) {
      if (!currentSourceView) {
        sourceCoverage.sync();
        sourceCode.innerHTML = "";
        sourceSearchMatchElements = [];
        state.sourceSearchMatchIndex = -1;
        sourceCode.classList.remove("compact-mode");
        sourceCode.classList.remove("plain-mode");
        renderSourceBookmarkBar();
        updateSourceSearchStatus();
        return;
      }
      const search = buildSourceSearchRegExp();
      state.sourceSearchError = search.error;
      const { lines, firstLineNumber, focusStartLine, focusEndLine } = currentSourceView;
      syncCurrentSourceBookmarkPreviews();
      const bookmarkSet = new Set(currentSourceBookmarkLines());
      const renderMode = resolveSourceRenderMode(currentSourceView);
      const compactMode = renderMode === "compact";
      const plainMode = renderMode === "plain";
      currentSourceView.renderMode = renderMode;
      sourceCoverage.sync();
      currentSourceView.virtualized = !plainMode && shouldVirtualizeSourceRender(currentSourceView);
      sourceCode.classList.toggle("compact-mode", compactMode);
      sourceCode.classList.toggle("plain-mode", plainMode);
      if (plainMode) {
        const textarea = document.createElement("textarea");
        textarea.className = "source-plain-text";
        textarea.readOnly = true;
        textarea.spellcheck = false;
        textarea.wrap = "off";
        textarea.value = ensureSourceText(currentSourceView);
        sourceCode.replaceChildren(textarea);
        finalizeRenderedSource(preferFocusLine);
        return;
      }
      ensureStructuredSourceSearchData(currentSourceView, search);
      if (currentSourceView.virtualized) {
        currentSourceView.lineHeight = measureSourceLineHeight(renderMode);
        currentSourceView.virtualStart = -1;
        currentSourceView.virtualEnd = -1;
        ensureSourceVirtualElements();
        if (preferFocusLine) {
          const focusScrollTop = sourceScrollTopForLine(currentSourceView, focusStartLine, "center");
          if (focusScrollTop !== null) {
            sourceCode.scrollTop = focusScrollTop;
          }
        }
        renderVisibleVirtualSourceWindow(true);
        finalizeRenderedSource(false);
        return;
      }
      const matchMap = currentStructuredSourceMatchMap();
      sourceCode.innerHTML = lines!
        .map((line, index) => buildSourceLineHtml(
          line,
          firstLineNumber + index,
          focusStartLine,
          focusEndLine,
          bookmarkSet,
          matchMap.get(firstLineNumber + index) || [],
          renderMode,
        ))
        .join("");
      sourceSearchMatchElements = Array.from(sourceCode.querySelectorAll<HTMLElement>(".source-find-hit"));
      finalizeRenderedSource(preferFocusLine);
    }

    function renderSourceLines(lines: string[], firstLineNumber: number, focusStartLine: number, focusEndLine: number, options: SourceLineOptions = {}) {
      currentSourceView = {
        lines,
        text: typeof options.text === "string" ? options.text : null,
        textLength: (Number.isInteger as (value: unknown) => value is number)(options.textLength) ? options.textLength : null,
        lineOffsets: Array.isArray(options.lineOffsets) ? options.lineOffsets : null,
        plainMetrics: null,
        plainSearchMatches: [],
        searchMatchRecords: [],
        searchMatchRangesByLine: new Map<number, SourceSearchRecord[]>(),
        searchSignature: null,
        firstLineNumber,
        focusStartLine,
        focusEndLine,
        renderMode: "full",
        virtualized: false,
        lineHeight: null,
        virtualStart: -1,
        virtualEnd: -1,
        targetKind: options.targetKind || currentSourceView?.targetKind || "instance",
        bookmarkKey: options.bookmarkKey || currentSourceView?.bookmarkKey || null
      };
      if (state.sourceBookmarkEditingKey !== currentSourceView.bookmarkKey) {
        clearSourceBookmarkRename();
      }
      renderCurrentSourceView(true);
    }

    function sourceRenderModeStatusSuffix(view: SourceView | null) {
      if (!view) {
        return "";
      }
      if (view.renderMode === "plain") {
        return "Large-source mode keeps the viewer responsive; line-click bookmarking is unavailable in this mode.";
      }
      if (view.renderMode === "compact") {
        return "Large-source highlighted mode keeps syntax colors while staying responsive.";
      }
      return "";
    }

    function applySourcePanelWindowState() {
      const sourceOpen = state.sourceNodeId !== null;
      const docked = state.mainViewMode === "coverage";
      const fullscreen = state.sourcePanelFullscreen && !docked;
      sourcePanel.classList.toggle("fullscreen", fullscreen);
      document.body.classList.toggle("source-fullscreen-active", fullscreen);
      document.body.classList.toggle("source-open", sourceOpen && !docked);
      if (appRoot) {
        appRoot.classList.toggle("source-open", sourceOpen && !docked);
      }
      toggleSourceFullscreenBtn.textContent = state.sourcePanelFullscreen ? "Windowed" : "Fullscreen";
      toggleSourceFullscreenBtn.setAttribute("aria-pressed", state.sourcePanelFullscreen ? "true" : "false");
      scheduleUiAnnotations();
    }

    function formatSourceLocation(target: SourceTarget | null) {
      if (!target || !target.filePath) {
        return "Source location unavailable";
      }
      const line = target.line || 1;
      const column = target.column || 1;
      return `${target.filePath}:${line}:${column}`;
    }

    function renderSourceRange(node: HierarchyNode, target: SourceTarget, sourceData: Pick<CachedSource, "lines">, startLine: number, endLine: number, message: string, bookmarkKey: string | null) {
      const lines = sourceData.lines;
      if (!lines.length) {
        sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · ${message}`;
        sourceCode.innerHTML = '<div class="source-line"><span class="source-lineno">-</span><span class="source-code-text">Source file is empty.</span></div>';
        sourceCode.classList.remove("compact-mode");
        sourceCode.classList.remove("plain-mode");
        currentSourceView = {
          firstLineNumber: 1,
          focusStartLine: 1,
          focusEndLine: 1,
          bookmarkKey: bookmarkKey || sourceBookmarkKeyForTarget(target)
        };
        renderSourceBookmarkBar();
        return;
      }
      const clampedStart = Math.min(Math.max(1, startLine), lines.length);
      const clampedEnd = Math.min(Math.max(clampedStart, endLine), lines.length);
      const subsetLines = lines.slice(clampedStart - 1, clampedEnd);
      sourceSubtitle.textContent = `${node.module} · ${target.locationLabel} · ${formatSourceLocation(target)} · lines ${clampedStart}-${clampedEnd} · ${message}`;
      renderSourceLines(
        subsetLines,
        clampedStart,
        clampedStart,
        clampedEnd,
        {
          bookmarkKey,
          targetKind: target.kind,
        },
      );
    }

    async function loadFullSource(target: SourceTarget, signal: AbortSignal) {
      const sourceUrl = resolveSourceUrl(target);
      if (!sourceUrl) {
        throw new Error("relative source path unavailable");
      }
      if (sourceTextCache.has(sourceUrl)) {
        return sourceTextCache.get(sourceUrl)!;
      }

      const response = await fetch(sourceUrl, { signal, cache: "no-store" });
      signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || 0;
      let fetchedBytes = 0;
      let text = "";
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parts: string[] = [];
        setSourceLoadProgress(
          totalBytes > 0 ? 2 : 8,
          "Downloading source...",
          totalBytes > 0 ? `0 / ${formatLoadingBytes(totalBytes)}` : "Receiving source bytes...",
        );
        while (true) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) {
            break;
          }
          fetchedBytes += value.byteLength;
          parts.push(decoder.decode(value, { stream: true }));
          const percent = totalBytes > 0
            ? (fetchedBytes / totalBytes) * 100
            : Math.min(92, 10 + parts.length * 8);
          setSourceLoadProgress(
            percent,
            "Downloading source...",
            totalBytes > 0
              ? `${formatLoadingBytes(fetchedBytes)} / ${formatLoadingBytes(totalBytes)}`
              : `${formatLoadingBytes(fetchedBytes)} received`,
          );
        }
        parts.push(decoder.decode());
        text = parts.join("");
      } else {
        setSourceLoadProgress(12, "Downloading source...", "Streaming progress is unavailable in this browser.");
        text = await response.text();
        signal.throwIfAborted();
        fetchedBytes = text.length;
      }
      const sourceData = {
        text,
        lines: text.split("\n"),
        lineOffsets: null,
      };
      sourceTextCache.set(sourceUrl, sourceData);
      return sourceData;
    }

    function closeSourcePanel() {
      sourceCoverage.close();
      if (sourceSearchInputTimer !== null) {
        clearTimeout(sourceSearchInputTimer);
        sourceSearchInputTimer = null;
      }
      cancelScheduledHoverUpdate();
      if (state.sourceAbortController) {
        state.sourceAbortController.abort();
        state.sourceAbortController = null;
      }
      state.sourceNodeId = null;
      state.sourceTargetKind = "instance";
      state.sourceRequestToken += 1;
      currentSourceView = null;
      sourceSearchMatchElements = [];
      state.sourceSearchMatchIndex = -1;
      state.sourceSearchError = "";
      state.sourcePanelFullscreen = false;
      clearSourceBookmarkRename();
      sourceCode.innerHTML = "";
      sourceCode.classList.remove("compact-mode");
      sourceCode.classList.remove("plain-mode");
      hideSourceLoadProgress();
      showSourceStatus("");
      openRawSourceLink.href = "#";
      openRawSourceLink.classList.add("hidden");
      applySourcePanelWindowState();
      sourcePanel.classList.remove("visible");
      renderSourceBookmarkBar();
      updateSourceSearchStatus();
      if (state.hoverId === null || state.hoverId === undefined) {
        hoverCard.classList.add("hidden");
        clearUiAnnotationHoverTargetWithin(hoverCard);
        return;
      }
      updateHover(state.hoverId, state.hoverAreaKind);
    }

    const renderSource = createSourceLoader({
      state,
      get currentSourceView() {
        return currentSourceView;
      },
      set currentSourceView(view: SourceView | null) {
        currentSourceView = view;
      },
      getNode, preferredSourceTargetKind, buildSourceTarget, resolveSourceUrl,
      sourceBookmarkKeyForTarget, sourceTitle, sourceSubtitle, sourceCode, openRawSourceLink,
      hoverCard, sourcePanel, cancelScheduledHoverUpdate, clearUiAnnotationHoverTargetWithin,
      applySourcePanelWindowState, renderCurrentSourceView, formatSourceLocation,
      hideSourceLoadProgress, setSourceLoadProgress, showSourceStatus, nextFrame,
      loadFullSource, renderSourceRange, renderSourceLines, emphasizeFocusedSourceRange,
      sourceRenderModeStatusSuffix, escapeHtml,
    });

    function bindSourceEvents() {

      closeSourceBtn.addEventListener("click", () => {
        closeSourcePanel();
      });

      toggleSourceFullscreenBtn.addEventListener("click", () => {
        state.sourcePanelFullscreen = !state.sourcePanelFullscreen;
        applySourcePanelWindowState();
        scheduleSourceVirtualRender(true);
      });

      sourceSearchModeSelect.addEventListener("change", () => {
        state.sourceSearchMode = sourceSearchModeSelect.value as ViewerState["sourceSearchMode"];
        state.sourceSearchMatchIndex = 0;
        renderCurrentSourceView(false);
      });

      sourceSearchInput.addEventListener("input", () => {
        applySourceSearchValue(sourceSearchInput.value);
      });

      sourceSearchInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        moveSourceSearch(event.shiftKey ? -1 : 1);
      });

      sourceSearchPrevBtn.addEventListener("click", () => {
        moveSourceSearch(-1);
      });

      sourceSearchNextBtn.addEventListener("click", () => {
        moveSourceSearch(1);
      });

      sourceCode.addEventListener("click", (event) => {
        const gutterButton = (event.target as HTMLElement).closest<HTMLElement>(".source-lineno");
        if (!gutterButton || !sourceCode.contains(gutterButton)) {
          return;
        }
        const lineNo = Number(gutterButton.dataset.line);
        if (!(Number.isInteger as (value: unknown) => value is number)(lineNo) || lineNo <= 0) {
          return;
        }
        event.preventDefault();
        toggleSourceBookmark(lineNo);
      });

      sourceCode.addEventListener("scroll", () => {
        scheduleSourceVirtualRender(false);
      });

      registerSearchHistoryInput(sourceSearchInput, "source-search", {
        apply: (value) => {
          applySourceSearchValue(value, { immediate: true });
        },
        getValue: () => state.sourceSearch
      });
    }

    return {
      setSourceWorkspace: (enabled: boolean) => {
        sourceCoverage.setWorkspaceMode(enabled);
        applySourcePanelWindowState();
      },
      selectCoverageMetric: sourceCoverage.selectMetric,
      refreshCoverage: () => {
        sourceCoverage.sync();
        if (!currentSourceView || currentSourceView.renderMode === "plain") return;
        if (currentSourceView.virtualized) scheduleSourceVirtualRender(true);
        else renderCurrentSourceView(false);
      },
      normalizeSourceBookmarks,
      sourceSearchModeSelect,
      sourceSearchInput,
      sourcePanel,
      closeSourcePanel,
      nodeHasAnySource,
      renderSource,
      nodeHasInstanceSource,
      nodeHasDefinitionSource,
      formatSourceLocation,
      buildSourceTarget,
      applySourcePanelWindowState,
      scheduleSourceVirtualRender,
      updateSourceSearchStatus,
      renderSourceLines,
      applySourceSearchValue,
      moveSourceSearch,
      bindSourceEvents,
      get currentSourceView() {
        return currentSourceView;
      }
    };
}
