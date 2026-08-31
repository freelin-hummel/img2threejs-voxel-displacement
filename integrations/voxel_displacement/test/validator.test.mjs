import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VXD_ATTRIBUTE_ENCODING,
  VXD_CELL_ORDER,
  VXD_CHUNK_EDGE,
  VXD_COORDINATE_SYSTEM,
  VXD_KIND,
  VXD_VERSION,
  VxdValidationError,
  assertValidChunkV1,
  assertValidDocumentV1,
  validateChunkV1,
  validateDocumentV1,
} from '../dist/index.js';

function cell(coordinate = [1, 2, 3]) {
  return {
    coordinate,
    attributes: {
      albedo: [10, 20, 30, 255],
      normal: [0, 0, 1],
      material: 4,
      flags: 0,
    },
  };
}

function chunk(coordinate = [0, 0, 0]) {
  return { coordinate, cells: [cell()] };
}

function document(chunks = [chunk()]) {
  return {
    kind: VXD_KIND,
    version: VXD_VERSION,
    grid: {
      chunkEdge: VXD_CHUNK_EDGE,
      cellSize: 0.025,
      origin: [0, -1, 2],
      coordinateSystem: VXD_COORDINATE_SYSTEM,
      cellOrder: VXD_CELL_ORDER,
    },
    attributes: VXD_ATTRIBUTE_ENCODING,
    chunks,
  };
}

test('valid chunks and documents pass without warnings', () => {
  assert.deepEqual(validateChunkV1(chunk()), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(validateDocumentV1(document()), { ok: true, errors: [], warnings: [] });
  assert.doesNotThrow(() => assertValidChunkV1(chunk()));
  assert.doesNotThrow(() => assertValidDocumentV1(document()));
});

test('chunk validator rejects duplicate cells and invalid attributes', () => {
  const invalid = chunk();
  invalid.cells.push(cell());
  invalid.cells[0].attributes.albedo = [0, 1, 2, 300];
  invalid.cells[0].attributes.normal = [0, 0, 2];
  invalid.cells[0].attributes.material = -1;
  invalid.cells[0].attributes.flags = 256;
  invalid.cells[1].attributes.displacement = 2;
  invalid.cells[1].coordinate = [8, 0, 0];

  const result = validateChunkV1(invalid);
  const codes = new Set(result.errors.map((entry) => entry.code));
  assert.equal(result.ok, false);
  assert.ok(codes.has('invalid-rgba8'));
  assert.ok(codes.has('non-unit-normal'));
  assert.ok(codes.has('invalid-material'));
  assert.ok(codes.has('invalid-flags'));
  assert.ok(codes.has('unsupported-displacement'));
  assert.ok(codes.has('invalid-vector'));

  assert.throws(() => assertValidChunkV1(invalid), VxdValidationError);
});

test('duplicate occupied coordinates are rejected', () => {
  const invalid = { coordinate: [0, 0, 0], cells: [cell(), cell()] };
  const result = validateChunkV1(invalid);
  assert.ok(result.errors.some((entry) => entry.code === 'duplicate-cell'));
});

test('chunk coordinates must fit the signed int32 binary header', () => {
  const result = validateChunkV1(chunk([0x8000_0000, 0, 0]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'invalid-vector'));
});

test('document validator checks fixed v1 encoding and unique chunk coordinates', () => {
  const invalid = document([chunk([0, 0, 0]), chunk([0, 0, 0])]);
  invalid.grid.cellSize = 0;
  invalid.grid.chunkEdge = 16;
  invalid.attributes = { ...VXD_ATTRIBUTE_ENCODING, normal: 'float32x3' };

  const result = validateDocumentV1(invalid);
  const codes = new Set(result.errors.map((entry) => entry.code));
  assert.equal(result.ok, false);
  assert.ok(codes.has('invalid-cell-size'));
  assert.ok(codes.has('invalid-chunk-edge'));
  assert.ok(codes.has('invalid-encoding'));
  assert.ok(codes.has('duplicate-chunk'));
});

test('empty data is valid but explicitly warned', () => {
  const emptyChunk = validateChunkV1({ coordinate: [0, 0, 0], cells: [] });
  assert.equal(emptyChunk.ok, true);
  assert.ok(emptyChunk.warnings.some((entry) => entry.code === 'empty-chunk'));

  const emptyDocument = validateDocumentV1(document([]));
  assert.equal(emptyDocument.ok, true);
  assert.ok(emptyDocument.warnings.some((entry) => entry.code === 'empty-document'));
});

test('noncanonical document ordering is a warning rather than a data error', () => {
  const result = validateDocumentV1(document([chunk([1, 0, 0]), chunk([0, 0, 0])]));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((entry) => entry.code === 'noncanonical-chunk-order'));
});
