import {
  VXD_CHUNK_CELL_COUNT,
  VXD_CHUNK_EDGE,
  type VxdCellCoordinateV1,
  type VxdChunkV1,
  type VxdUnitNormal,
} from "./contracts.js";
import { assertValidChunkV1 } from "./validate.js";

const MAGIC = new Uint8Array([0x56, 0x58, 0x44, 0x31]); // ASCII "VXD1"
const HEADER_BYTES = 24;
export const VXD_OCCUPANCY_BYTES = VXD_CHUNK_CELL_COUNT / 8;
export const VXD_ATTRIBUTE_BYTES = 8;
export const VXD_CHUNK_FIXED_BYTES = HEADER_BYTES + VXD_OCCUPANCY_BYTES;

const EDGE_OFFSET = 4;
const ATTRIBUTE_STRIDE_OFFSET = 5;
const FLAGS_OFFSET = 6;
const RESERVED_BYTE_OFFSET = 7;
const CHUNK_X_OFFSET = 8;
const CHUNK_Y_OFFSET = 12;
const CHUNK_Z_OFFSET = 16;
const OCCUPIED_COUNT_OFFSET = 20;
const RESERVED_WORD_OFFSET = 22;
const OCCUPANCY_OFFSET = HEADER_BYTES;

export class VxdCodecError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VxdCodecError";
    this.code = code;
  }
}

function signNotZero(value: number): number {
  return value < 0 ? -1 : 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Encode a unit vector as two octahedral UNORM8 channels. */
export function encodeNormalOct8V1(normal: VxdUnitNormal): readonly [number, number] {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!Number.isFinite(length) || length === 0) {
    throw new VxdCodecError("invalid-normal", "normal must be a finite non-zero vector");
  }
  const x0 = normal[0] / length;
  const y0 = normal[1] / length;
  const z0 = normal[2] / length;
  const inverseL1 = 1 / (Math.abs(x0) + Math.abs(y0) + Math.abs(z0));
  let x = x0 * inverseL1;
  let y = y0 * inverseL1;
  const z = z0 * inverseL1;
  if (z < 0) {
    const previousX = x;
    x = (1 - Math.abs(y)) * signNotZero(previousX);
    y = (1 - Math.abs(previousX)) * signNotZero(y);
  }
  const quantize = (component: number): number => Math.round((clamp(component, -1, 1) * 0.5 + 0.5) * 255);
  return [quantize(x), quantize(y)];
}

/** Decode two octahedral UNORM8 channels to a normalized vector. */
export function decodeNormalOct8V1(xByte: number, yByte: number): VxdUnitNormal {
  if (!Number.isInteger(xByte) || xByte < 0 || xByte > 255 || !Number.isInteger(yByte) || yByte < 0 || yByte > 255) {
    throw new VxdCodecError("invalid-oct-normal", "octahedral normal channels must be bytes");
  }
  let x = xByte / 255 * 2 - 1;
  let y = yByte / 255 * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const previousX = x;
    x = (1 - Math.abs(y)) * signNotZero(previousX);
    y = (1 - Math.abs(previousX)) * signNotZero(y);
  }
  const inverseLength = 1 / Math.hypot(x, y, z);
  return [x * inverseLength, y * inverseLength, z * inverseLength];
}

/** Convert a local cell coordinate to the canonical x-fastest bit index. */
export function cellIndexV1(coordinate: VxdCellCoordinateV1): number {
  const [x, y, z] = coordinate;
  if (
    !Number.isInteger(x) || x < 0 || x >= VXD_CHUNK_EDGE
    || !Number.isInteger(y) || y < 0 || y >= VXD_CHUNK_EDGE
    || !Number.isInteger(z) || z < 0 || z >= VXD_CHUNK_EDGE
  ) {
    throw new VxdCodecError(
      "cell-out-of-range",
      `cell coordinate must contain integers from 0 to ${VXD_CHUNK_EDGE - 1}`,
    );
  }
  return x + VXD_CHUNK_EDGE * (y + VXD_CHUNK_EDGE * z);
}

/** Convert a canonical bit index back to a local cell coordinate. */
export function cellCoordinateV1(index: number): VxdCellCoordinateV1 {
  if (!Number.isInteger(index) || index < 0 || index >= VXD_CHUNK_CELL_COUNT) {
    throw new VxdCodecError("cell-index-out-of-range", `cell index must be from 0 to ${VXD_CHUNK_CELL_COUNT - 1}`);
  }
  const x = index % VXD_CHUNK_EDGE;
  const y = Math.floor(index / VXD_CHUNK_EDGE) % VXD_CHUNK_EDGE;
  const z = Math.floor(index / (VXD_CHUNK_EDGE * VXD_CHUNK_EDGE));
  return [x, y, z];
}

export function encodedChunkByteLengthV1(occupiedCellCount: number): number {
  if (!Number.isInteger(occupiedCellCount) || occupiedCellCount < 0 || occupiedCellCount > VXD_CHUNK_CELL_COUNT) {
    throw new VxdCodecError(
      "invalid-occupied-count",
      `occupied cell count must be from 0 to ${VXD_CHUNK_CELL_COUNT}`,
    );
  }
  return VXD_CHUNK_FIXED_BYTES + occupiedCellCount * VXD_ATTRIBUTE_BYTES;
}

/**
 * Encode one chunk. Cell input order is ignored: the occupancy bits and attribute records are always
 * emitted in ascending canonical cell-index order.
 */
export function encodeChunkV1(chunk: VxdChunkV1): Uint8Array {
  assertValidChunkV1(chunk);
  const cells = [...chunk.cells].sort((left, right) => cellIndexV1(left.coordinate) - cellIndexV1(right.coordinate));
  const bytes = new Uint8Array(encodedChunkByteLengthV1(cells.length));
  bytes.set(MAGIC, 0);
  bytes[EDGE_OFFSET] = VXD_CHUNK_EDGE;
  bytes[ATTRIBUTE_STRIDE_OFFSET] = VXD_ATTRIBUTE_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt32(CHUNK_X_OFFSET, chunk.coordinate[0], true);
  view.setInt32(CHUNK_Y_OFFSET, chunk.coordinate[1], true);
  view.setInt32(CHUNK_Z_OFFSET, chunk.coordinate[2], true);
  view.setUint16(OCCUPIED_COUNT_OFFSET, cells.length, true);

  cells.forEach((cell, order) => {
    const index = cellIndexV1(cell.coordinate);
    bytes[OCCUPANCY_OFFSET + (index >>> 3)]! |= 1 << (index & 7);
    const attributeOffset = VXD_CHUNK_FIXED_BYTES + order * VXD_ATTRIBUTE_BYTES;
    const { albedo, normal, material, flags } = cell.attributes;
    bytes.set(albedo, attributeOffset);
    const [normalX, normalY] = encodeNormalOct8V1(normal);
    bytes[attributeOffset + 4] = normalX;
    bytes[attributeOffset + 5] = normalY;
    bytes[attributeOffset + 6] = material;
    bytes[attributeOffset + 7] = flags;
  });

  return bytes;
}

function requireHeader(bytes: Uint8Array): DataView {
  if (!(bytes instanceof Uint8Array)) {
    throw new VxdCodecError("invalid-input", "encoded chunk must be a Uint8Array");
  }
  if (bytes.byteLength < VXD_CHUNK_FIXED_BYTES) {
    throw new VxdCodecError(
      "truncated-chunk",
      `encoded chunk needs at least ${VXD_CHUNK_FIXED_BYTES} bytes; received ${bytes.byteLength}`,
    );
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new VxdCodecError("bad-magic", "encoded chunk does not start with VXD1");
    }
  }
  if (bytes[EDGE_OFFSET] !== VXD_CHUNK_EDGE) {
    throw new VxdCodecError("unsupported-chunk-edge", `VXD v1 requires chunk edge ${VXD_CHUNK_EDGE}`);
  }
  if (bytes[ATTRIBUTE_STRIDE_OFFSET] !== VXD_ATTRIBUTE_BYTES) {
    throw new VxdCodecError("unsupported-attribute-stride", `VXD v1 requires ${VXD_ATTRIBUTE_BYTES}-byte attributes`);
  }
  if (bytes[FLAGS_OFFSET] !== 0 || bytes[RESERVED_BYTE_OFFSET] !== 0) {
    throw new VxdCodecError("unsupported-flags", "VXD v1 flag and reserved bytes must be zero");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(RESERVED_WORD_OFFSET, true) !== 0) {
    throw new VxdCodecError("nonzero-reserved", "VXD v1 reserved header word must be zero");
  }
  return view;
}

function bitCount(byte: number): number {
  let value = byte;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

/** Decode one exact VXD v1 chunk; trailing bytes and inconsistent occupancy counts are rejected. */
export function decodeChunkV1(bytes: Uint8Array): VxdChunkV1 {
  const view = requireHeader(bytes);
  const occupiedCount = view.getUint16(OCCUPIED_COUNT_OFFSET, true);
  if (occupiedCount > VXD_CHUNK_CELL_COUNT) {
    throw new VxdCodecError("invalid-occupied-count", `occupied count exceeds ${VXD_CHUNK_CELL_COUNT}`);
  }
  const expectedLength = encodedChunkByteLengthV1(occupiedCount);
  if (bytes.byteLength !== expectedLength) {
    throw new VxdCodecError(
      bytes.byteLength < expectedLength ? "truncated-attributes" : "trailing-bytes",
      `encoded chunk length must be ${expectedLength} bytes for ${occupiedCount} cells; received ${bytes.byteLength}`,
    );
  }

  let setBits = 0;
  for (let offset = 0; offset < VXD_OCCUPANCY_BYTES; offset += 1) {
    setBits += bitCount(bytes[OCCUPANCY_OFFSET + offset]!);
  }
  if (setBits !== occupiedCount) {
    throw new VxdCodecError(
      "occupancy-count-mismatch",
      `occupancy bitset contains ${setBits} cells but header declares ${occupiedCount}`,
    );
  }

  const cells: VxdChunkV1["cells"][number][] = [];
  let attributeOrder = 0;
  for (let index = 0; index < VXD_CHUNK_CELL_COUNT; index += 1) {
    const occupied = (bytes[OCCUPANCY_OFFSET + (index >>> 3)]! & (1 << (index & 7))) !== 0;
    if (!occupied) continue;
    const attributeOffset = VXD_CHUNK_FIXED_BYTES + attributeOrder * VXD_ATTRIBUTE_BYTES;
    cells.push({
      coordinate: cellCoordinateV1(index),
      attributes: {
        albedo: [
          bytes[attributeOffset]!,
          bytes[attributeOffset + 1]!,
          bytes[attributeOffset + 2]!,
          bytes[attributeOffset + 3]!,
        ],
        normal: decodeNormalOct8V1(bytes[attributeOffset + 4]!, bytes[attributeOffset + 5]!),
        material: bytes[attributeOffset + 6]!,
        flags: bytes[attributeOffset + 7]!,
      },
    });
    attributeOrder += 1;
  }

  return {
    coordinate: [
      view.getInt32(CHUNK_X_OFFSET, true),
      view.getInt32(CHUNK_Y_OFFSET, true),
      view.getInt32(CHUNK_Z_OFFSET, true),
    ],
    cells,
  };
}
