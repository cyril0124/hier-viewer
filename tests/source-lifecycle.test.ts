import assert from "node:assert/strict";
import { test } from "vitest";
import { createSourceLoader, type SourceKind } from "../rust-hier-viewer/src/html/frontend/source-loader";

function sourceRuntime(kind: SourceKind) {
  const frames: Array<() => void> = [];
  const renders: Array<number | string> = [];
  const statuses: string[] = [];
  const element = () => ({ textContent: "", innerHTML: "", href: "", classList: { add() {}, remove() {} } });
  const state = {
    sourceRequestToken: 0,
    sourceAbortController: null as AbortController | null,
    sourceNodeId: null as number | null,
    sourceTargetKind: kind,
  };
  const dependencies = {
    state,
    currentSourceView: { oldFile: true } as { oldFile: boolean } | null,
    sourceTitle: element(), sourceSubtitle: element(), sourceCode: element(),
    openRawSourceLink: element(), hoverCard: element(), sourcePanel: element(),
    getNode: (id: number) => ({ id, path: `node-${id}`, module: "Block" }),
    preferredSourceTargetKind: () => kind,
    buildSourceTarget: (node: { id: number }) => ({ kind, line: 1, endLine: 2, titleSuffix: "Source", url: `/${node.id}.sv` }),
    resolveSourceUrl: (target: { url: string }) => target.url,
    sourceBookmarkKeyForTarget: (target: { url: string }) => target.url,
    cancelScheduledHoverUpdate() {}, clearUiAnnotationHoverTargetWithin() {},
    applySourcePanelWindowState() {}, formatSourceLocation: () => "file:1",
    renderCurrentSourceView() {}, hideSourceLoadProgress() {}, setSourceLoadProgress() {},
    showSourceStatus: (status: string) => { statuses.push(status); },
    nextFrame: () => new Promise<void>((resolve) => frames.push(resolve)),
    loadFullSource: async (target: { url: string }) => ({ text: target.url, lines: [target.url, "endmodule"] }),
    renderSourceRange: (node: { id: number }) => { renders.push(node.id); },
    renderSourceLines: (lines: string[]) => { renders.push(lines[0]); },
    emphasizeFocusedSourceRange: () => { renders.push("focus"); },
    sourceRenderModeStatusSuffix: () => "", escapeHtml: (text: string) => text,
  };
  const renderSource = createSourceLoader(dependencies);
  const advance = async () => {
    assert.ok(frames.length, "render has reached the next frame");
    frames.shift()!();
    await new Promise(setImmediate);
  };
  return { dependencies, renderSource, state, renders, statuses, advance };
}

for (const kind of ["definition", "instance"] as const) {
  test(`${kind} source finishes rendering when it is not cancelled`, async () => {
    const { renderSource, renders, statuses, advance } = sourceRuntime(kind);
    const pending = renderSource(1);
    for (let i = 0; i < (kind === "definition" ? 2 : 4); i += 1) await advance();
    await pending;
    assert.deepEqual(renders, kind === "definition" ? [1] : ["/1.sv", "focus", "focus"]);
    assert.match(statuses.at(-1)!, /source loaded|Full file loaded/);
  });

  for (const boundary of (kind === "definition" ? [0, 1] : [0, 1, 2, 3])) {
    test(`${kind} source cancellation at frame ${boundary} prevents stale UI writes`, async () => {
      const { dependencies, renderSource, state, renders, statuses, advance } = sourceRuntime(kind);
      const pending = renderSource(1);
      assert.equal(dependencies.currentSourceView, null, "old search and bookmark context cleared immediately");
      for (let i = 0; i < boundary; i += 1) await advance();
      state.sourceAbortController!.abort();
      state.sourceAbortController = new AbortController();
      state.sourceRequestToken += 1;
      state.sourceNodeId = 2;
      const beforeRenders = renders.slice();
      const beforeStatuses = statuses.slice();
      await advance();
      await pending;
      assert.deepEqual(renders, beforeRenders);
      assert.deepEqual(statuses, beforeStatuses);
    });
  }
}
