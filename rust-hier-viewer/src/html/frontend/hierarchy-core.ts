import { coverageFilterActive, coverageMatchesFilter } from "./coverage-display.js";
import type { AnalysisDefinition, HierarchyNode, ViewerState } from "./types";

export type HierarchyModelNode = Pick<HierarchyNode,
  "id" | "name" | "module" | "definitionKey" | "parent" | "children" | "path" |
  "moduleInternalSignalCount" | "subtreeInternalSignalCount" | "definitionLine" | "definitionEndLine"
>;

export type HierarchyState = Pick<ViewerState,
  "homeRoot"
  | "analysisPatternMode"
  | "analysisLocalCounts"
  | "analysisLocalLocs"
  | "analysisSubtreeCounts"
  | "analysisSubtreeLocs"
  | "analysisLocalRatios"
  | "analysisSubtreeRatios"
  | "analysisError"
  | "analysisMode"
  | "chartPanelDirty"
  | "analysisMaxSubtreeCount"
  | "analysisPattern"
  | "analysisVisibleMaxCount"
  | "analysisVisibleMaxLoc"
  | "analysisVisibleMaxRatio"
  | "analysisVisibleSubtreeQualified"
  | "depthLimit"
  | "currentRoot"
  | "analysisLegendVisibleSubtree"
  | "filterScope"
  | "filterMode"
  | "search"
  | "coverage"
  | "searchError"
  | "matches"
  | "matchIds"
  | "matchVisibleIds"
  | "matchSubtreeIds"
  | "matchLines"
  | "treePanelDirty"
  | "matchPanelDirty"
  | "treeCollapsedIds"
>;

export interface HierarchyDependencies {
  analysisDefinitions: AnalysisDefinition[] | null;
  analysisFile: string | null;
  loadAnalysisDefinitions: () => Promise<AnalysisDefinition[]>;
  draw: () => void;
  selectedAnalysisLegendBuckets: () => number[];
  analysisLegendLocalBucketMatches: (id: number) => boolean;
}

export function createHierarchyRuntime<N extends HierarchyModelNode>(
  nodes: N[],
  state: HierarchyState,
  dependencies: HierarchyDependencies,
) {
    let analysisDefinitions = dependencies.analysisDefinitions;
    let analysisDefinitionMap: Map<string, AnalysisDefinition["signalStats"]> | null = null;
    let analysisDefinitionsPromise: Promise<void> | null = null;
    let analysisDefinitionsLoadError = "";
    const subtreeDepthCache = new Array<number>(nodes.length).fill(-1);
    const DATA = { analysisFile: dependencies.analysisFile };
    const {
      loadAnalysisDefinitions,
      draw,
      selectedAnalysisLegendBuckets,
      analysisLegendLocalBucketMatches,
    } = dependencies;

    function getNode(id: number): N {
      return nodes[id];
    }

    function getAnalysisDefinitionMap() {
      if (analysisDefinitionMap === null) {
        analysisDefinitionMap = new Map(
          (analysisDefinitions || []).map((definition) => [definition.definitionKey, definition.signalStats || []])
        );
      }
      return analysisDefinitionMap;
    }

    function subtreeDepth(nodeId: number): number {
      if (subtreeDepthCache[nodeId] !== -1) {
        return subtreeDepthCache[nodeId];
      }
      const order = [nodeId];
      for (let i = 0; i < order.length; i += 1) {
        for (const childId of getNode(order[i]).children) {
          if (subtreeDepthCache[childId] === -1) {
            order.push(childId);
          }
        }
      }
      // Reverse parent-before-child order so every child depth is already cached.
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i];
        let depth = 0;
        for (const childId of getNode(id).children) {
          depth = Math.max(depth, subtreeDepthCache[childId] + 1);
        }
        subtreeDepthCache[id] = depth;
      }
      return subtreeDepthCache[nodeId];
    }

    function visibleParent(nodeId: number): number | null {
      const node = getNode(nodeId);
      if (node.parent === null || node.parent === undefined) {
        return null;
      }
      if (state.homeRoot !== 0 && node.parent === 0) {
        return null;
      }
      return node.parent;
    }

    function wildcardToRegExp(pattern: string): RegExp {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
      return new RegExp(`^${escaped}$`, "i");
    }

    function splitSearchTerms(raw: string): string[] {
      return raw
        .split(/[;\n]+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
    }

    function buildSignalMatcher(term: string): (signalName: string) => boolean {
      if (term.startsWith("re:")) {
        const regex = new RegExp(term.slice(3), "i");
        return (signalName) => regex.test(signalName);
      }
      if (term.startsWith("wc:")) {
        const regex = wildcardToRegExp(term.slice(3));
        return (signalName) => regex.test(signalName);
      }
      if (state.analysisPatternMode === "regex") {
        const regex = new RegExp(term, "i");
        return (signalName) => regex.test(signalName);
      }
      if (state.analysisPatternMode === "wildcard") {
        const regex = wildcardToRegExp(term);
        return (signalName) => regex.test(signalName);
      }
      const q = term.toLowerCase();
      return (signalName) => signalName.toLowerCase().includes(q);
    }

    function moduleLocalLoc(node: HierarchyModelNode | null | undefined): number {
      if (!node) {
        return 0;
      }
      const startLine = Number.isFinite(node.definitionLine) ? node.definitionLine : null;
      if (startLine === null || startLine <= 0) {
        return 0;
      }
      const endLine = Number.isFinite(node.definitionEndLine) && node.definitionEndLine! >= startLine
        ? node.definitionEndLine
        : startLine;
      return Math.max(0, endLine! - startLine + 1);
    }

    function computeAnalysisSubtree(nodeId: number): { count: number; loc: number } {
      const order = [nodeId];
      for (let i = 0; i < order.length; i += 1) {
        for (const childId of getNode(order[i]).children) {
          order.push(childId);
        }
      }
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i];
        const node = getNode(id);
        const localCount = state.analysisLocalCounts[id] || 0;
        let subtreeCount = localCount;
        let subtreeLoc = state.analysisLocalLocs[id] || 0;
        for (const childId of node.children) {
          subtreeCount += state.analysisSubtreeCounts[childId];
          subtreeLoc += state.analysisSubtreeLocs[childId];
        }
        state.analysisSubtreeCounts[id] = subtreeCount;
        state.analysisSubtreeLocs[id] = subtreeLoc;
        state.analysisLocalRatios[id] = node.moduleInternalSignalCount > 0
          ? localCount / node.moduleInternalSignalCount
          : 0;
        state.analysisSubtreeRatios[id] = node.subtreeInternalSignalCount > 0
          ? subtreeCount / node.subtreeInternalSignalCount
          : 0;
      }
      return {
        count: state.analysisSubtreeCounts[nodeId],
        loc: state.analysisSubtreeLocs[nodeId],
      };
    }

    function ensureAnalysisDefinitionsRequested() {
      if (Array.isArray(analysisDefinitions) || !DATA.analysisFile || analysisDefinitionsPromise) {
        return;
      }
      analysisDefinitionsLoadError = "";
      state.analysisError = `Loading signal analysis data from ${DATA.analysisFile}...`;
      analysisDefinitionsPromise = loadAnalysisDefinitions()
        .then((definitions) => {
          analysisDefinitions = definitions;
          analysisDefinitionMap = null;
          state.analysisError = "";
        })
        .catch((error: unknown) => {
          analysisDefinitions = [];
          analysisDefinitionMap = null;
          analysisDefinitionsLoadError = `Failed to load signal analysis data: ${(error as { message?: unknown }).message || error}`;
          state.analysisError = analysisDefinitionsLoadError;
        })
        .finally(() => {
          analysisDefinitionsPromise = null;
          if (!state.analysisError && state.analysisMode !== "none") {
            buildSignalAnalysis();
          }
          state.chartPanelDirty = true;
          draw();
        });
    }

    function buildSignalAnalysis() {
      state.analysisError = "";
      state.analysisLocalCounts.fill(0);
      state.analysisSubtreeCounts.fill(0);
      state.analysisLocalLocs.fill(0);
      state.analysisSubtreeLocs.fill(0);
      state.analysisLocalRatios.fill(0);
      state.analysisSubtreeRatios.fill(0);
      state.analysisMaxSubtreeCount = 0;

      if (state.analysisMode === "none") {
        return;
      }
      if (state.analysisMode === "loc") {
        let hasAnyLoc = false;
        for (const node of nodes) {
          const localLoc = moduleLocalLoc(node);
          state.analysisLocalLocs[node.id] = localLoc;
          if (localLoc > 0) {
            hasAnyLoc = true;
          }
        }
        if (!hasAnyLoc) {
          state.analysisError = "This bundle has no module definition LOC data.";
          return;
        }
        computeAnalysisSubtree(0);
        return;
      }

      if (analysisDefinitionsLoadError) {
        state.analysisError = analysisDefinitionsLoadError;
        return;
      }

      if (!Array.isArray(analysisDefinitions)) {
        ensureAnalysisDefinitionsRequested();
        return;
      }

      if (!analysisDefinitions.length) {
        state.analysisError = "This bundle has no signal analysis data. Re-export from slang-hier-exporter --sqlite.";
        return;
      }

      const raw = state.analysisPattern.trim();
      if (!raw) {
        return;
      }

      let matchers: Array<(signalName: string) => boolean>;
      try {
        matchers = splitSearchTerms(raw).map((term) => buildSignalMatcher(term));
      } catch (error) {
        state.analysisError = `Invalid analysis pattern: ${(error as { message?: unknown }).message}`;
        return;
      }
      if (!matchers.length) {
        return;
      }

      const definitionMap = getAnalysisDefinitionMap();
      const definitionCounts = new Map<string, number>();
      for (const node of nodes) {
        if (node.definitionKey === null || node.definitionKey === undefined) {
          continue;
        }
        let localCount = definitionCounts.get(node.definitionKey);
        if (localCount === undefined) {
          localCount = 0;
          const signalStats = definitionMap.get(node.definitionKey);
          if (signalStats) {
            for (const stat of signalStats) {
              if (matchers.some((matcher) => matcher(stat.signalName))) {
                localCount += stat.signalCount || 0;
              }
            }
          }
          definitionCounts.set(node.definitionKey, localCount);
        }
        state.analysisLocalCounts[node.id] = localCount;
      }

      computeAnalysisSubtree(0);
      state.analysisMaxSubtreeCount = state.analysisLocalCounts.reduce(
        (maxValue, value) => Math.max(maxValue, value || 0),
        0
      );
    }

    function analysisActive() {
      return state.analysisMode === "loc"
        ? !state.analysisError
        : state.analysisMode !== "none" && !state.analysisError && state.analysisPattern.trim().length > 0;
    }

    function analysisLocalValue(nodeId: number): number {
      if (!analysisActive()) {
        return 0;
      }
      if (state.analysisMode === "count") {
        return state.analysisLocalCounts[nodeId] || 0;
      }
      if (state.analysisMode === "loc") {
        return state.analysisLocalLocs[nodeId] || 0;
      }
      return state.analysisLocalRatios[nodeId] || 0;
    }

    function updateAnalysisVisibleExtents() {
      state.analysisVisibleMaxCount = 0;
      state.analysisVisibleMaxLoc = 0;
      state.analysisVisibleMaxRatio = 0;
      state.analysisVisibleSubtreeQualified.fill(false);
      if (!analysisActive()) {
        return;
      }

      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;

      const order = [state.currentRoot];
      const depths = [0];
      for (let i = 0; i < order.length; i += 1) {
        const nodeId = order[i];
        state.analysisVisibleMaxCount = Math.max(
          state.analysisVisibleMaxCount,
          state.analysisLocalCounts[nodeId] || 0
        );
        state.analysisVisibleMaxLoc = Math.max(
          state.analysisVisibleMaxLoc,
          state.analysisLocalLocs[nodeId] || 0
        );
        state.analysisVisibleMaxRatio = Math.max(
          state.analysisVisibleMaxRatio,
          state.analysisLocalRatios[nodeId] || 0
        );
        state.analysisVisibleSubtreeQualified[nodeId] = analysisNodeQualified(nodeId);
        if (depths[i] < maxDepth) {
          for (const childId of getNode(nodeId).children) {
            order.push(childId);
            depths.push(depths[i] + 1);
          }
        }
      }
      // Children are complete before their parents, including depth-limited frontiers.
      for (let i = order.length - 1; i >= 0; i -= 1) {
        if (depths[i] >= maxDepth) continue;
        const nodeId = order[i];
        for (const childId of getNode(nodeId).children) {
          state.analysisVisibleSubtreeQualified[nodeId] ||= state.analysisVisibleSubtreeQualified[childId];
        }
      }
    }

    function analysisNodeQualified(nodeId: number): boolean {
      if (!analysisActive()) {
        return false;
      }
      return analysisLocalValue(nodeId) > 0;
    }

    function updateAnalysisLegendVisibleSubtree() {
      state.analysisLegendVisibleSubtree.fill(false);
      const selectedBuckets = selectedAnalysisLegendBuckets();
      if (!analysisActive() || !selectedBuckets.length) {
        return;
      }

      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;
      const order = [state.currentRoot];
      const depths = [0];
      for (let i = 0; i < order.length; i += 1) {
        const nodeId = order[i];
        state.analysisLegendVisibleSubtree[nodeId] = analysisLegendLocalBucketMatches(nodeId);
        if (depths[i] < maxDepth) {
          for (const childId of getNode(nodeId).children) {
            order.push(childId);
            depths.push(depths[i] + 1);
          }
        }
      }
      for (let i = order.length - 1; i >= 0; i -= 1) {
        if (depths[i] >= maxDepth) continue;
        const nodeId = order[i];
        for (const childId of getNode(nodeId).children) {
          state.analysisLegendVisibleSubtree[nodeId] ||= state.analysisLegendVisibleSubtree[childId];
        }
      }
    }

    function filterTargetText(node: HierarchyModelNode): string {
      if (state.filterScope === "path") return node.path;
      if (state.filterScope === "instance") return node.name;
      if (state.filterScope === "module") return node.module;
      return `${node.path} ${node.module}`;
    }

    function buildMatcher(term: string): (node: HierarchyModelNode) => boolean {
      if (term.startsWith("re:")) {
        const regex = new RegExp(term.slice(3), "i");
        return (node) => regex.test(filterTargetText(node));
      }
      if (term.startsWith("wc:")) {
        const regex = wildcardToRegExp(term.slice(3));
        return (node) => regex.test(filterTargetText(node));
      }
      if (state.filterMode === "regex") {
        const regex = new RegExp(term, "i");
        return (node) => regex.test(filterTargetText(node));
      }
      if (state.filterMode === "wildcard") {
        const regex = wildcardToRegExp(term);
        return (node) => regex.test(filterTargetText(node));
      }
      const q = term.toLowerCase();
      return (node) => filterTargetText(node).toLowerCase().includes(q);
    }

    function buildMatches() {
      const raw = state.search.trim();
      state.searchError = "";
      state.matches = [];
      state.matchIds = new Set();
      state.matchVisibleIds = new Set();
      state.matchSubtreeIds = new Set();
      state.matchLines = [];
      state.treePanelDirty = true;
      state.matchPanelDirty = true;
      const coverageActive = coverageFilterActive(state.coverage);
      if (!raw && !coverageActive) {
        return;
      }

      const terms = splitSearchTerms(raw);
      let matchers: Array<(node: HierarchyModelNode) => boolean>;
      try {
        matchers = terms.map((term) => buildMatcher(term));
      } catch (error) {
        state.searchError = `Invalid filter: ${(error as { message?: unknown }).message}`;
        return;
      }

      state.matches = nodes
        .filter(node => (!coverageActive || node.id !== 0 || state.homeRoot === 0)
          && (!raw || matchers.some(matcher => matcher(node)))
          && coverageMatchesFilter(state.coverage, node.id))
        .map((node) => node.id);
      state.matchIds = new Set(state.matches);
      state.matchLines = state.matches.map((id) => {
        const node = getNode(id);
        return `${node.path || node.name} <${node.module}>`;
      });
      const visible = new Set<number>();
      const subtree = new Set<number>();
      for (const id of state.matches) {
        let cursor: number | null = id;
        while (cursor !== null && cursor !== undefined && !visible.has(cursor)) {
          visible.add(cursor);
          cursor = visibleParent(cursor);
        }
        cursor = id;
        while (cursor !== null && cursor !== undefined && !subtree.has(cursor)) {
          subtree.add(cursor);
          cursor = getNode(cursor).parent;
        }
      }
      state.matchVisibleIds = visible;
      state.matchSubtreeIds = subtree;
    }

    function forEachVisibleTreeNode(visitor: (nodeId: number, depth: number) => void): void {
      const treeRootId = state.homeRoot;
      const maxDepth = state.depthLimit === null ? Infinity : state.depthLimit;
      const currentPathIds = new Set<number>();
      let cursor: number | null = state.currentRoot;
      while (cursor !== null && cursor !== undefined) {
        currentPathIds.add(cursor);
        if (cursor === treeRootId) {
          break;
        }
        cursor = visibleParent(cursor);
      }

      const stack = [treeRootId, 0];
      while (stack.length) {
        const depth = stack.pop()!;
        const nodeId = stack.pop()!;
        visitor(nodeId, depth);
        const node = getNode(nodeId);
        if ((depth >= maxDepth && !currentPathIds.has(nodeId)) || state.treeCollapsedIds.has(nodeId)) {
          continue;
        }
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i], depth + 1);
        }
      }
    }

    return {
      getNode,
      getAnalysisDefinitionMap,
      subtreeDepth,
      visibleParent,
      wildcardToRegExp,
      splitSearchTerms,
      buildSignalMatcher,
      moduleLocalLoc,
      computeAnalysisSubtree,
      ensureAnalysisDefinitionsRequested,
      buildSignalAnalysis,
      analysisActive,
      analysisLocalValue,
      analysisNodeQualified,
      updateAnalysisVisibleExtents,
      updateAnalysisLegendVisibleSubtree,
      filterTargetText,
      buildMatcher,
      buildMatches,
      forEachVisibleTreeNode,
      subtreeDepthCache,
      get pendingAnalysis(): Promise<void> | null {
        return analysisDefinitionsPromise;
      },
    };
}
