import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VXD_ATTRIBUTE_BYTES,
  VXD_CHUNK_FIXED_BYTES,
  VXD_OCCUPANCY_BYTES,
  VxdCodecError,
  cellCoordinateV1,
  cellIndexV1,
  decodeChunkV1,
  decodeNormalOct8V1,
  encodeChunkV1,
  encodeNormalOct8V1,
  encodedChunkByteLengthV1,
} from '../dist/index.js';

const firstCell = {
  coordinate: [0, 0, 0],
  attributes: {
    albedo: [12, 34, 56, 255],
    normal: [0, 0, 1],
    material: 7,
    flags: 5,
  },
};

const lastCell = {
  coordinate: [7, 7, 7],
  attributes: {
    albedo: [240, 128, 3, 64],
    normal: [0, -1, 0],
    material: 255,
    flags: 0xa5,
  },
};

test('cell indexing is x-fastest across the fixed 8-cubed grid', () => {
  assert.equal(cellIndexV1([0, 0, 0]), 0);
  assert.equal(cellIndexV1([7, 0, 0]), 7);
  assert.equal(cellIndexV1([0, 1, 0]), 8);
  assert.equal(cellIndexV1([0, 0, 1]), 64);
  assert.equal(cellIndexV1([7, 7, 7]), 511);
  assert.deepEqual(cellCoordinateV1(511), [7, 7, 7]);
  for (let index = 0; index < 512; index += 1) {
    assert.equal(cellIndexV1(cellCoordinateV1(index)), index);
  }
  assert.throws(() => cellIndexV1([8, 0, 0]), VxdCodecError);
  assert.throws(() => cellCoordinateV1(512), VxdCodecError);
});

test('chunk encoding is deterministic regardless of input cell order', () => {
  const forward = encodeChunkV1({ coordinate: [-2, 4, 9], cells: [firstCell, lastCell] });
  const reverse = encodeChunkV1({ coordinate: [-2, 4, 9], cells: [lastCell, firstCell] });

  assert.deepEqual(forward, reverse);
  assert.equal(forward.byteLength, encodedChunkByteLengthV1(2));
  assert.equal(forward.byteLength, VXD_CHUNK_FIXED_BYTES + 2 * VXD_ATTRIBUTE_BYTES);
  assert.equal(VXD_OCCUPANCY_BYTES, 64);
  assert.equal(forward[24] & 1, 1);
  assert.equal(forward[24 + 63] & 0x80, 0x80);
});

test('single-cell golden vector pins the little-endian header and attribute layout', () => {
  const encoded = encodeChunkV1({ coordinate: [-2, 4, 9], cells: [firstCell] });
  assert.deepEqual(Array.from(encoded.subarray(0, 24)), [
    0x56, 0x58, 0x44, 0x31,
    0x08, 0x08, 0x00, 0x00,
    0xfe, 0xff, 0xff, 0xff,
    0x04, 0x00, 0x00, 0x00,
    0x09, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00,
  ]);
  assert.equal(encoded[24], 0x01);
  assert.ok(encoded.subarray(25, 88).every((byte) => byte === 0));
  assert.deepEqual(Array.from(encoded.subarray(88)), [
    12, 34, 56, 255,
    128, 128,
    7,
    5,
  ]);
});

test('chunk round trip preserves exact scalar attributes and quantized normals', () => {
  const source = { coordinate: [-2, 4, 9], cells: [lastCell, firstCell] };
  const decoded = decodeChunkV1(encodeChunkV1(source));

  assert.deepEqual(decoded.coordinate, source.coordinate);
  assert.deepEqual(decoded.cells.map((cell) => cell.coordinate), [[0, 0, 0], [7, 7, 7]]);
  for (const [index, expected] of [firstCell, lastCell].entries()) {
    const actual = decoded.cells[index];
    assert.deepEqual(actual.attributes.albedo, expected.attributes.albedo);
    assert.equal(actual.attributes.material, expected.attributes.material);
    assert.equal(actual.attributes.flags, expected.attributes.flags);
    assert.equal('displacement' in actual.attributes, false);
    const dot = actual.attributes.normal.reduce(
      (sum, component, axis) => sum + component * expected.attributes.normal[axis],
      0,
    );
    assert.ok(dot > 0.9999, `normal dot product ${dot} did not survive octahedral quantization`);
  }
});

test('octahedral normal codec covers both hemispheres', () => {
  for (const normal of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0]]) {
    const encoded = encodeNormalOct8V1(normal);
    const decoded = decodeNormalOct8V1(...encoded);
    const dot = decoded.reduce((sum, component, axis) => sum + component * normal[axis], 0);
    assert.ok(dot > 0.9999, `${normal} decoded with dot product ${dot}`);
  }
});

test('decoder rejects corrupt headers, lengths, and occupancy counts', () => {
  const encoded = encodeChunkV1({ coordinate: [0, 0, 0], cells: [firstCell] });

  const badMagic = encoded.slice();
  badMagic[0] = 0;
  assert.throws(() => decodeChunkV1(badMagic), /VXD1/);

  const badCount = encoded.slice();
  new DataView(badCount.buffer).setUint16(20, 2, true);
  assert.throws(() => decodeChunkV1(badCount), /length must be/);

  const badOccupancy = encoded.slice();
  badOccupancy[24] = 0;
  assert.throws(() => decodeChunkV1(badOccupancy), /bitset contains 0 cells/);

  const unsupportedChunkFlags = encoded.slice();
  unsupportedChunkFlags[6] = 1;
  assert.throws(() => decodeChunkV1(unsupportedChunkFlags), /flag and reserved bytes must be zero/);

  const reservedWord = encoded.slice();
  reservedWord[22] = 1;
  assert.throws(() => decodeChunkV1(reservedWord), /reserved header word must be zero/);

  const trailing = new Uint8Array(encoded.length + 1);
  trailing.set(encoded);
  assert.throws(() => decodeChunkV1(trailing), /length must be/);

  assert.throws(() => decodeChunkV1(encoded.subarray(0, 20)), /at least/);
});

test('a fully occupied chunk uses all 512 bits and round trips', () => {
  const cells = [];
  for (let index = 0; index < 512; index += 1) {
    cells.push({
      coordinate: cellCoordinateV1(index),
      attributes: {
        albedo: [index & 255, 0, 255, 255],
        normal: [0, 0, 1],
        material: index & 255,
        flags: index & 3,
      },
    });
  }
  const encoded = encodeChunkV1({ coordinate: [0, 0, 0], cells });
  assert.equal(encoded.byteLength, encodedChunkByteLengthV1(512));
  assert.ok(encoded.subarray(24, 88).every((byte) => byte === 0xff));
  assert.equal(decodeChunkV1(encoded).cells.length, 512);
});
