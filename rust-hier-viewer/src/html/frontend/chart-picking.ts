export interface BarGrid {
  heights: ArrayLike<number>;
  columns: number;
  cellSize: number;
  barSize: number;
  baseThickness: number;
  coverage: boolean;
}

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** Pick the nearest bar or pedestal without allocating per-instance Three.js meshes. */
export function pickBarGrid(origin: Vector3, direction: Vector3, grid: BarGrid): number {
  const rows = Math.ceil(grid.heights.length / grid.columns);
  const halfWidth = (grid.columns - 1) * grid.cellSize / 2;
  const halfDepth = (rows - 1) * grid.cellSize / 2;
  const inverseX = 1 / direction.x;
  const inverseY = 1 / direction.y;
  const inverseZ = 1 / direction.z;
  const halfBar = grid.barSize / 2;
  const halfPedestal = halfBar * 1.06;
  const pedestalBottom = grid.coverage ? -grid.baseThickness + 0.003 : 0;
  const pedestalTop = pedestalBottom + grid.baseThickness;
  let nearestDistance = Infinity;
  let nearestIndex = -1;

  function boxDistance(x: number, z: number, halfSize: number, bottom: number, top: number): number {
    let near = -Infinity;
    let far = Infinity;
    // Parallel rays need explicit slab checks: 0 * Infinity would otherwise be NaN.
    if (direction.x === 0) {
      if (origin.x < x - halfSize || origin.x > x + halfSize) return Infinity;
    } else {
      const a = (x - halfSize - origin.x) * inverseX;
      const b = (x + halfSize - origin.x) * inverseX;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (direction.z === 0) {
      if (origin.z < z - halfSize || origin.z > z + halfSize) return Infinity;
    } else {
      const a = (z - halfSize - origin.z) * inverseZ;
      const b = (z + halfSize - origin.z) * inverseZ;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (near > far || far < 0 || near > nearestDistance) return Infinity;
    if (direction.y === 0) {
      if (origin.y < bottom || origin.y > top) return Infinity;
    } else {
      const a = (bottom - origin.y) * inverseY;
      const b = (top - origin.y) * inverseY;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    // The bars use front faces only, so a camera inside a box cannot see its exit face.
    if (near > far || near < 0) return Infinity;
    return near;
  }

  for (let index = 0; index < grid.heights.length; index++) {
    const x = (index % grid.columns) * grid.cellSize - halfWidth;
    const z = Math.floor(index / grid.columns) * grid.cellSize - halfDepth;
    const barDistance = grid.heights[index] > 0
      ? boxDistance(x, z, halfBar, 0, grid.heights[index])
      : Infinity;
    const pedestalDistance = boxDistance(x, z, halfPedestal, pedestalBottom, pedestalTop);
    const distance = Math.min(barDistance, pedestalDistance);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}
