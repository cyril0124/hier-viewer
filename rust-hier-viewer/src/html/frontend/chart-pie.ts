import type { ChartEntry, PieViewState } from './chart-types.js';

interface CanvasPieOptions {
  host: HTMLElement;
  entries: ChartEntry[];
  view: PieViewState;
  title: string;
  subtitle: string;
  textColor: string;
  mutedColor: string;
  clampView: () => void;
  onHover: (entry: ChartEntry | null) => void;
  onSelect: (entry: ChartEntry) => void;
  onViewChange: () => void;
}

/** Keep every sector selectable while caching raster work between camera changes. */
export function createCanvasPie(options: CanvasPieOptions) {
  const { host, entries, view } = options;
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-pie-canvas';
  canvas.setAttribute('aria-label', 'Hierarchy chart; use the instance legend to select a module');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  const ctx = canvas.getContext('2d')!;
  const cache = document.createElement('canvas');
  const cacheCtx = cache.getContext('2d')!;
  const width = host.clientWidth;
  const height = host.clientHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  cache.width = Math.ceil(canvas.width * 1.5);
  cache.height = Math.ceil(canvas.height * 1.5);
  const cx = view.baseW * 0.44;
  const cy = view.baseH * 0.52;
  const outerRadius = Math.min(view.baseW, view.baseH) * 0.33;
  const innerRadius = outerRadius * 0.44;
  const angles = new Float64Array(entries.length + 1);
  const paths = entries.map((entry, index) => {
    angles[index + 1] = angles[index] + entry.fraction * Math.PI * 2;
    const start = angles[index] - Math.PI / 2;
    const end = angles[index + 1] - Math.PI / 2;
    const path = new Path2D();
    path.arc(cx, cy, outerRadius, start, end);
    path.arc(cx, cy, innerRadius, end, start, true);
    path.closePath();
    return path;
  });
  const groups = new Map<string, { path: Path2D; fill: string; stroke: string }>();
  for (let index = 0; index < entries.length; index++) {
    const { fill, stroke } = entries[index].style;
    const key = `${fill}/${stroke}`;
    let group = groups.get(key);
    if (!group) {
      group = { path: new Path2D(), fill, stroke };
      groups.set(key, group);
    }
    group.path.addPath(paths[index]);
  }
  const entryIndices = new Map(entries.map((entry, index) => [entry.id, index]));
  let hovered = -1;
  let frame = 0;
  let refineTimer = 0;
  let cacheView: { x: number; y: number; w: number; h: number } | null = null;

  function renderCache() {
    cacheView = { x: view.x - view.w * 0.25, y: view.y - view.h * 0.25, w: view.w * 1.5, h: view.h * 1.5 };
    const scale = cache.width / cacheView.w;
    cacheCtx.resetTransform();
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    cacheCtx.setTransform(scale, 0, 0, cache.height / cacheView.h, -cacheView.x * scale, -cacheView.y * cache.height / cacheView.h);
    // Padding lets panning reuse the raster without exposing blank edges.
    cacheCtx.lineWidth = 1.25 * view.w / width;
    // Batch equal colors so rasterization does not flush once per tiny sector.
    for (const group of groups.values()) {
      cacheCtx.fillStyle = group.fill;
      cacheCtx.strokeStyle = group.stroke;
      cacheCtx.fill(group.path);
      cacheCtx.stroke(group.path);
    }
  }

  function drawLabels() {
    const zoom = view.baseW / view.w;
    const labelRadius = innerRadius + (outerRadius - innerRadius) * 0.54;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = options.textColor;
    ctx.textAlign = 'center';
    for (let index = 0; index < entries.length; index++) {
      const availableWidth = (labelRadius * (angles[index + 1] - angles[index]) - 14) * zoom;
      if (availableWidth < 30) continue;
      const angle = (angles[index] + angles[index + 1]) / 2 - Math.PI / 2;
      const text = entries[index].node.name || entries[index].node.module;
      const maxChars = Math.floor(availableWidth / 7.2);
      const label = text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
      let rotation = angle + Math.PI / 2;
      if (rotation > Math.PI / 2 && rotation < Math.PI * 1.5) rotation += Math.PI;
      ctx.save();
      ctx.translate(cx + Math.cos(angle) * labelRadius, cy + Math.sin(angle) * labelRadius);
      ctx.rotate(rotation);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(options.title, cx, cy - 8);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = options.mutedColor;
    ctx.fillText(options.subtitle, cx, cy + 14);
  }

  function paint() {
    frame = 0;
    if (!cacheView || view.x < cacheView.x || view.y < cacheView.y || view.x + view.w > cacheView.x + cacheView.w || view.y + view.h > cacheView.y + cacheView.h) renderCache();
    const saved = cacheView!;
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.drawImage(cache, (saved.x - view.x) * width / view.w, (saved.y - view.y) * height / view.h, saved.w * width / view.w, saved.h * height / view.h);
    ctx.setTransform(canvas.width / view.w, 0, 0, canvas.height / view.h, -view.x * canvas.width / view.w, -view.y * canvas.height / view.h);
    if (hovered >= 0) {
      const angle = (angles[hovered] + angles[hovered + 1]) / 2 - Math.PI / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill(paths[hovered]);
      ctx.globalCompositeOperation = 'source-over';
      ctx.translate(Math.cos(angle) * 12, Math.sin(angle) * 12);
      ctx.fillStyle = entries[hovered].style.fill;
      ctx.strokeStyle = entries[hovered].style.stroke;
      ctx.lineWidth = 2.5 * view.w / width;
      ctx.fill(paths[hovered]);
      ctx.stroke(paths[hovered]);
      ctx.restore();
    }
    drawLabels();
    canvas.style.cursor = view.dragging ? 'grabbing' : hovered >= 0 ? 'pointer' : view.w < view.baseW ? 'grab' : 'default';
    canvas.dataset.viewBox = `${view.x} ${view.y} ${view.w} ${view.h}`;
  }

  function refresh() {
    frame ||= requestAnimationFrame(paint);
    clearTimeout(refineTimer);
    // Restore full pixel resolution after zoom input stops, without a large raster per event.
    refineTimer = window.setTimeout(() => {
      if (!cacheView || cacheView.w !== view.w * 1.5) {
        renderCache();
        frame ||= requestAnimationFrame(paint);
      }
    }, 120);
  }

  function hover(id: number | null) {
    const index = id === null ? -1 : entryIndices.get(id) ?? -1;
    if (index === hovered) return;
    hovered = index;
    frame ||= requestAnimationFrame(paint);
  }

  function sectorAt(x: number, y: number): number {
    const radius = Math.hypot(x, y);
    if (radius < innerRadius || radius > outerRadius) return -1;
    const angle = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (angles[middle + 1] <= angle) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, entries.length - 1);
  }

  function pick(event: MouseEvent): ChartEntry | null {
    const rect = canvas.getBoundingClientRect();
    const x = view.x + (event.clientX - rect.left) * view.w / rect.width - cx;
    const y = view.y + (event.clientY - rect.top) * view.h / rect.height - cy;
    // The highlighted sector is painted last and displaced outwards. Its visible
    // position takes priority, and the area vacated by that sector is empty.
    if (hovered >= 0) {
      const angle = (angles[hovered] + angles[hovered + 1]) / 2 - Math.PI / 2;
      if (sectorAt(x - Math.cos(angle) * 12, y - Math.sin(angle) * 12) === hovered) {
        return entries[hovered];
      }
    }
    const index = sectorAt(x, y);
    return index >= 0 && index !== hovered ? entries[index] : null;
  }

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const factor = event.deltaY < 0 ? 1 / 1.18 : 1.18;
    const nextW = Math.max(view.baseW / 18, Math.min(view.baseW, view.w * factor));
    const nextH = Math.max(view.baseH / 18, Math.min(view.baseH, view.h * factor));
    view.x += x * (view.w - nextW);
    view.y += y * (view.h - nextH);
    view.w = nextW;
    view.h = nextH;
    options.clampView();
    refresh();
    options.onViewChange();
  }, { passive: false });
  canvas.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    view.dragging = true;
    view.dragMoved = false;
    view.lastClientX = event.clientX;
    view.lastClientY = event.clientY;
  });
  canvas.addEventListener('mousemove', event => {
    if (!view.dragging) {
      options.onHover(pick(event));
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dx = (event.clientX - view.lastClientX) * view.w / rect.width;
    const dy = (event.clientY - view.lastClientY) * view.h / rect.height;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      view.dragMoved = true;
      view.suppressClick = true;
    }
    view.x -= dx;
    view.y -= dy;
    view.lastClientX = event.clientX;
    view.lastClientY = event.clientY;
    options.clampView();
    refresh();
    options.onViewChange();
  });
  canvas.addEventListener('mouseleave', () => options.onHover(null));
  canvas.addEventListener('click', event => {
    if (view.suppressClick) { view.suppressClick = false; return; }
    const entry = pick(event);
    if (entry) options.onSelect(entry);
  });
  host.appendChild(canvas);
  paint();
  return { refresh, hover, dispose() { cancelAnimationFrame(frame); clearTimeout(refineTimer); cache.width = cache.height = 0; canvas.remove(); } };
}
