import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeCoreBundle } from '../rust-hier-viewer/src/html/frontend/binary';

function emptyCoreBundle(): ArrayBuffer {
  // HVC1 version 1, followed by empty string and node tables.
  const buffer = new ArrayBuffer(16);
  new Uint8Array(buffer).set(new TextEncoder().encode('HVC1'));
  new DataView(buffer).setUint32(4, 1, true);
  return buffer;
}

const schematic = { version: 1, directory: 'schematic' };

test.each(['lazy', 'static'] as const)('decodeCoreBundle preserves schematic mode %s', mode => {
  const metadata = { schematic: { ...schematic, mode } };
  const decoded = decodeCoreBundle(emptyCoreBundle(), metadata);
  assert.deepEqual(decoded.schematic, metadata.schematic);
});

test('decodeCoreBundle accepts legacy schematic metadata without adding a mode', () => {
  assert.deepEqual(decodeCoreBundle(emptyCoreBundle(), { schematic }).schematic, schematic);
  assert.deepEqual(decodeCoreBundle(emptyCoreBundle(), { schematic: { ...schematic, mode: undefined } }).schematic, schematic);
});

test('decodeCoreBundle accepts bundles without schematic metadata', () => {
  for (const metadata of [{}, { schematic: null }, { schematic: undefined }]) {
    assert.equal(decodeCoreBundle(emptyCoreBundle(), metadata).schematic, null);
  }
});

test.each([
  { mode: 'automatic' }, { mode: '' }, { mode: 'LAZY' }, { mode: null },
  { mode: true }, { mode: 1 }, { mode: {} }, { mode: [] },
])('decodeCoreBundle rejects invalid schematic mode $mode', ({ mode }) => {
  assert.throws(() => decodeCoreBundle(emptyCoreBundle(), { schematic: { ...schematic, mode } }),
    /Invalid schematic bundle metadata/);
});

test.each([
  { ...schematic, version: 2, mode: 'lazy' },
  { ...schematic, directory: '../schematic', mode: 'static' },
])('decodeCoreBundle still validates schematic version and directory: %j', metadata => {
  assert.throws(() => decodeCoreBundle(emptyCoreBundle(), { schematic: metadata }),
    /Invalid schematic bundle metadata/);
});
