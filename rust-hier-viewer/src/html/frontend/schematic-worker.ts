import { layoutScene } from './schematic-layout.js';
import { buildScene } from './schematic-model.js';
import type { LayoutRequest, LayoutResponse } from './schematic-types.js';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
};

let latestRequest = 0;

worker.onmessage = (event): void => {
  const request = event.data;
  const sequence = ++latestRequest;
  const started = performance.now();
  const post = (response: LayoutResponse): void => {
    if (sequence === latestRequest) worker.postMessage(response);
  };

  void (async () => {
    try {
      post({ id: request.id, stage: 'Building signal groups' });
      const scene = buildScene(request.graph, new Set(request.expanded), request.detail);
      await layoutScene(scene, stage => post({ id: request.id, stage }));
      post({ id: request.id, scene, elapsedMs: performance.now() - started });
    } catch (error) {
      post({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
