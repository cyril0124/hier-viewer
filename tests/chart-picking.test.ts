import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { pickBarGrid, type BarGrid } from '../rust-hier-viewer/src/html/frontend/chart-picking.js';

const grid: BarGrid = { heights: [2, 4, 0, 1], columns: 2, cellSize: 2, barSize: 1, baseThickness: 0.08, coverage: true };

test('parallel top-down rays identify every instance, including a zero-height pedestal', () => {
  for (let index = 0; index < grid.heights.length; index++) {
    const origin = { x: (index % 2) * 2 - 1, y: 10, z: Math.floor(index / 2) * 2 - 1 };
    assert.equal(pickBarGrid(origin, { x: 0, y: -1, z: 0 }, grid), index);
  }
  assert.equal(pickBarGrid({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, grid), -1, 'Grid gaps are not selectable');
});

test('side rays choose the nearest surface and pass over shorter bars', () => {
  const side = { x: 1, y: 0, z: 0 };
  assert.equal(pickBarGrid({ x: -10, y: 1, z: -1 }, side, grid), 0);
  assert.equal(pickBarGrid({ x: -10, y: 3, z: -1 }, side, grid), 1);
  assert.equal(pickBarGrid({ x: -10, y: 5, z: -1 }, side, grid), -1);
  assert.equal(pickBarGrid({ x: -10, y: 1, z: -1 }, { x: -1, y: 0, z: 0 }, grid), -1, 'Surfaces behind the camera do not match');
});

test('slab boundaries and zero direction components never lose valid hits', () => {
  assert.equal(pickBarGrid({ x: -1.5, y: 10, z: -1 }, { x: 0, y: -1, z: 0 }, grid), 0);
  assert.equal(pickBarGrid({ x: -1, y: 0.5, z: 10 }, { x: 0, y: 0, z: -1 }, grid), 0, 'Zero coverage bars have no height');
  assert.equal(pickBarGrid({ x: -1, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, grid), 2, 'Pedestals still have a selectable surface');
});

test('a camera inside a bar does not select its invisible back face', () => {
  assert.equal(pickBarGrid({ x: 1, y: 3, z: -1 }, { x: 1, y: 0, z: 0 }, grid), -1);
});

test('the last partial row has no phantom bars', () => {
  const partial = { ...grid, heights: [1, 1, 0] };
  assert.equal(pickBarGrid({ x: 1, y: 10, z: 1 }, { x: 0, y: -1, z: 0 }, partial), -1);
  assert.equal(pickBarGrid({ x: -1, y: 10, z: 1 }, { x: 0, y: -1, z: 0 }, partial), 2);
});

test('pedestal footprints remain selectable at their outer edges in both height modes', () => {
  for (const coverage of [false, true]) {
    assert.equal(pickBarGrid({ x: -1.52, y: 10, z: -1 }, { x: 0, y: -1, z: 0 }, { ...grid, coverage }), 0);
    assert.equal(pickBarGrid({ x: -1.54, y: 10, z: -1 }, { x: 0, y: -1, z: 0 }, { ...grid, coverage }), -1);
  }
});
