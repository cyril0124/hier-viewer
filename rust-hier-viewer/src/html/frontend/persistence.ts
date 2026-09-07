import type { HierarchyNode, ViewerState, SourceBookmark } from "./types.js";
import type { SearchHistorySession, SearchHistoryOptions } from "./main-types.js";

import { validTheme, normalizeAnalysisLegendFilter } from "./ui.js";

export interface PersistenceDependencies {
  state: ViewerState;
  normalizeSourceBookmarks: (raw: unknown) => Record<string, SourceBookmark[]>;
  nodes: HierarchyNode[];
  expandTreePath: (nodeId: number) => void;
}

export function createPersistence(deps: PersistenceDependencies) {
    const {
      state,
      normalizeSourceBookmarks,
      nodes,
      expandTreePath
    } = deps;

    const SEARCH_HISTORY_LIMIT = 24;

    const STORAGE_KEY = `hier-viewer:${window.location.pathname}`;

    const searchHistorySessions = new Map<string, SearchHistorySession>();

    function savePersistedState() {
      try {
        const snapshot = {
          theme: state.theme,
          metric: state.metric,
          weightedVariableWeight: state.weightedVariableWeight,
          weightedNetWeight: state.weightedNetWeight,
          layoutMode: state.layoutMode,
          decomposition: state.decomposition,
          analysisMode: state.analysisMode,
          analysisPatternMode: state.analysisPatternMode,
          analysisPattern: state.analysisPattern,
          analysisLegendFilter: state.analysisLegendFilter,
          toolbarCollapsed: state.toolbarCollapsed,
          selectMode: state.selectMode,
          advancedPopoverLeft: state.advancedPopoverLeft,
          advancedPopoverTop: state.advancedPopoverTop,
          depthLimit: state.depthLimit,
          search: state.search,
          filterScope: state.filterScope,
          filterMode: state.filterMode,
          sourceBookmarksByFile: state.sourceBookmarksByFile,
          searchHistoryByField: state.searchHistoryByField,
          treePanelOpen: state.treePanelOpen,
          matchPanelOpen: state.matchPanelOpen,
          mainViewMode: state.mainViewMode,
          chartPanelOpen: state.chartPanelOpen,
          chartMode: state.chartMode,
          chartRenderMode: state.chartRenderMode,
          chartLevel: state.chartLevel,
          chartPanelWidth: state.chartPanelWidth,
          chartPanelHeight: state.chartPanelHeight,
          chartPanelLeft: state.chartPanelLeft,
          chartPanelTop: state.chartPanelTop,
          treeCollapsedIds: Array.from(state.treeCollapsedIds),
          treePanelWidth: state.treePanelWidth,
          matchPanelWidth: state.matchPanelWidth,
          matchPanelHeight: state.matchPanelHeight,
          matchPanelLeft: state.matchPanelLeft,
          matchPanelTop: state.matchPanelTop,
          hoverCardLeft: state.hoverCardLeft,
          hoverCardTop: state.hoverCardTop,
          zenOverlayLeft: state.zenOverlayLeft,
          zenOverlayTop: state.zenOverlayTop,
          treemapAnalysisLegendLeft: state.treemapAnalysisLegendLeft,
          treemapAnalysisLegendTop: state.treemapAnalysisLegendTop
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch (_) {
      }
    }

    function restorePersistedState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved: Record<string, unknown> = JSON.parse(raw);
        if (typeof saved.theme === "string" && validTheme(saved.theme)) {
          state.theme = saved.theme;
        }
        if ((["instances", "leaves", "signals", "weighted_signals"] as readonly unknown[]).includes(saved.metric)) {
          state.metric = saved.metric as ViewerState["metric"];
        }
        if (typeof saved.weightedVariableWeight === "number" && saved.weightedVariableWeight >= 0) {
          state.weightedVariableWeight = saved.weightedVariableWeight;
        }
        if (typeof saved.weightedNetWeight === "number" && saved.weightedNetWeight >= 0) {
          state.weightedNetWeight = saved.weightedNetWeight;
        }
        if ((["classic", "accurate"] as readonly unknown[]).includes(saved.layoutMode)) {
          state.layoutMode = saved.layoutMode as ViewerState["layoutMode"];
        }
        if ((["subtree", "self"] as readonly unknown[]).includes(saved.decomposition)) {
          state.decomposition = saved.decomposition as ViewerState["decomposition"];
        }
        if ((["none", "ratio", "count", "loc"] as readonly unknown[]).includes(saved.analysisMode)) {
          state.analysisMode = saved.analysisMode as ViewerState["analysisMode"];
        }
        if ((["text", "wildcard", "regex"] as readonly unknown[]).includes(saved.analysisPatternMode)) {
          state.analysisPatternMode = saved.analysisPatternMode as ViewerState["analysisPatternMode"];
        }
        if (typeof saved.analysisPattern === "string") {
          state.analysisPattern = saved.analysisPattern;
        }
        state.analysisLegendFilter = normalizeAnalysisLegendFilter(saved.analysisLegendFilter);
        if (saved.sourceBookmarksByFile && typeof saved.sourceBookmarksByFile === "object") {
          state.sourceBookmarksByFile = normalizeSourceBookmarks(saved.sourceBookmarksByFile);
        }
        state.searchHistoryByField = normalizeSearchHistoryMap(saved.searchHistoryByField);
        state.toolbarCollapsed = !!saved.toolbarCollapsed;
        state.selectMode = !!saved.selectMode;
        if (typeof saved.advancedPopoverLeft === "number") state.advancedPopoverLeft = saved.advancedPopoverLeft;
        if (typeof saved.advancedPopoverTop === "number") state.advancedPopoverTop = saved.advancedPopoverTop;
        state.depthLimit = saved.depthLimit === null
          ? null
          : (Number.isInteger as (value: unknown) => value is number)(saved.depthLimit) && saved.depthLimit > 0
            ? saved.depthLimit
            : null;
        if (typeof saved.search === "string") state.search = saved.search;
        if ((["both", "path", "instance", "module"] as readonly unknown[]).includes(saved.filterScope)) {
          state.filterScope = saved.filterScope as ViewerState["filterScope"];
        }
        if ((["text", "wildcard", "regex"] as readonly unknown[]).includes(saved.filterMode)) {
          state.filterMode = saved.filterMode as ViewerState["filterMode"];
        }
        state.treePanelOpen = !!saved.treePanelOpen;
        state.matchPanelOpen = !!saved.matchPanelOpen;
        if ((["treemap", "pie2d", "three3d"] as readonly unknown[]).includes(saved.mainViewMode)) {
          state.mainViewMode = saved.mainViewMode as ViewerState["mainViewMode"];
        } else if (saved.chartPanelOpen) {
          state.mainViewMode = saved.chartRenderMode === "three3d" ? "three3d" : "pie2d" as ViewerState["mainViewMode"];
        }
        state.chartPanelOpen = state.mainViewMode !== "treemap";
        if ((["weighted_bits", "analysis", "coverage"] as readonly unknown[]).includes(saved.chartMode)) {
          state.chartMode = saved.chartMode as ViewerState["chartMode"];
        }
        if ((["pie2d", "three3d"] as readonly unknown[]).includes(saved.chartRenderMode)) {
          state.chartRenderMode = saved.chartRenderMode as ViewerState["chartRenderMode"];
        }
        if (saved.chartLevel === null) {
          state.chartLevel = null;
        } else if ((Number.isInteger as (value: unknown) => value is number)(saved.chartLevel) && saved.chartLevel > 0) {
          state.chartLevel = saved.chartLevel;
        }
        if (typeof saved.chartPanelWidth === "number") state.chartPanelWidth = saved.chartPanelWidth;
        if (typeof saved.chartPanelHeight === "number") state.chartPanelHeight = saved.chartPanelHeight;
        if (typeof saved.chartPanelLeft === "number") state.chartPanelLeft = saved.chartPanelLeft;
        if (typeof saved.chartPanelTop === "number") state.chartPanelTop = saved.chartPanelTop;
        if (Array.isArray(saved.treeCollapsedIds)) {
          state.treeCollapsedIds = new Set(
            saved.treeCollapsedIds.filter((id: unknown) => (Number.isInteger as (value: unknown) => value is number)(id) && id >= 0 && id < nodes.length)
          );
        }
        if (typeof saved.treePanelWidth === "number") state.treePanelWidth = saved.treePanelWidth;
        if (typeof saved.matchPanelWidth === "number") state.matchPanelWidth = saved.matchPanelWidth;
        if (typeof saved.matchPanelHeight === "number") state.matchPanelHeight = saved.matchPanelHeight;
        if (typeof saved.matchPanelLeft === "number") state.matchPanelLeft = saved.matchPanelLeft;
        if (typeof saved.matchPanelTop === "number") state.matchPanelTop = saved.matchPanelTop;
        if (typeof saved.hoverCardLeft === "number") state.hoverCardLeft = saved.hoverCardLeft;
        if (typeof saved.hoverCardTop === "number") state.hoverCardTop = saved.hoverCardTop;
        if (typeof saved.zenOverlayLeft === "number") state.zenOverlayLeft = saved.zenOverlayLeft;
        if (typeof saved.zenOverlayTop === "number") state.zenOverlayTop = saved.zenOverlayTop;
        if (typeof saved.treemapAnalysisLegendLeft === "number") {
          state.treemapAnalysisLegendLeft = saved.treemapAnalysisLegendLeft;
        }
        if (typeof saved.treemapAnalysisLegendTop === "number") {
          state.treemapAnalysisLegendTop = saved.treemapAnalysisLegendTop;
        }
        expandTreePath(state.currentRoot);
      } catch (_) {
      }
    }

    function normalizeSearchHistoryMap(raw: unknown): Record<string, string[]> {
      if (!raw || typeof raw !== "object") {
        return {};
      }
      const normalized: Record<string, string[]> = {};
      for (const [key, entries] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(entries)) {
          continue;
        }
        const seen = new Set();
        const cleaned: string[] = [];
        for (const entry of entries as unknown[]) {
          if (typeof entry !== "string") {
            continue;
          }
          const trimmed = entry.trim();
          if (!trimmed || seen.has(trimmed)) {
            continue;
          }
          seen.add(trimmed);
          cleaned.push(trimmed);
          if (cleaned.length >= SEARCH_HISTORY_LIMIT) {
            break;
          }
        }
        if (cleaned.length) {
          normalized[key] = cleaned;
        }
      }
      return normalized;
    }

    function searchHistoryEntries(historyKey: string) {
      return state.searchHistoryByField[historyKey] || [];
    }

    function commitSearchHistoryEntry(historyKey: string, value: unknown) {
      if (!historyKey) {
        return;
      }
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed) {
        return;
      }
      const nextEntries = [
        trimmed,
        ...searchHistoryEntries(historyKey).filter((entry) => entry !== trimmed),
      ].slice(0, SEARCH_HISTORY_LIMIT);
      state.searchHistoryByField[historyKey] = nextEntries;
      savePersistedState();
    }

    function searchHistorySession(historyKey: string) {
      if (!searchHistorySessions.has(historyKey)) {
        searchHistorySessions.set(historyKey, {
          index: -1,
          draft: "",
        });
      }
      return searchHistorySessions.get(historyKey)!;
    }

    function resetSearchHistorySession(historyKey: string, draft = "") {
      const session = searchHistorySession(historyKey);
      session.index = -1;
      session.draft = draft;
    }

    function navigateSearchHistory(historyKey: string, direction: number, getCurrentValue: () => string, applyValue: NonNullable<SearchHistoryOptions["apply"]>) {
      const entries = searchHistoryEntries(historyKey);
      if (!entries.length) {
        return false;
      }
      const session = searchHistorySession(historyKey);
      if (session.index === -1) {
        session.draft = getCurrentValue();
      }
      if (direction < 0) {
        if (session.index >= entries.length - 1) {
          return false;
        }
        session.index += 1;
      } else {
        if (session.index === -1) {
          return false;
        }
        session.index -= 1;
      }
      const nextValue = session.index === -1 ? session.draft : entries[session.index];
      applyValue(nextValue, { fromHistory: true });
      return true;
    }

    function registerSearchHistoryInput(input: HTMLInputElement | null, historyKey: string, options: SearchHistoryOptions = {}) {
      if (!input || !historyKey || typeof options.apply !== "function") {
        return;
      }
      const getCurrentValue = typeof options.getValue === "function"
        ? options.getValue
        : () => input.value;
      const commit = (rawValue = getCurrentValue()) => {
        commitSearchHistoryEntry(historyKey, rawValue);
        resetSearchHistorySession(historyKey, getCurrentValue());
      };
      input.addEventListener("input", () => {
        resetSearchHistorySession(historyKey, getCurrentValue());
      });
      input.addEventListener("blur", () => {
        commit();
      });
      input.addEventListener("keydown", (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) {
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const moved = navigateSearchHistory(
            historyKey,
            event.key === "ArrowUp" ? -1 : 1,
            getCurrentValue,
            options.apply!,
          );
          if (moved) {
            event.preventDefault();
          }
          return;
        }
        if (event.key === "Enter") {
          commit();
        }
      });
    }

    return {
      restorePersistedState,
      savePersistedState,
      registerSearchHistoryInput
    };
}
