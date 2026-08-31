/** Renderer-neutral contracts for Voxel Displacement Data (VXD) version 1. */

export const VXD_KIND = "voxel-displacement-data" as const;
export const VXD_VERSION = 1 as const;
export const VXD_CHUNK_EDGE = 8 as const;
export const VXD_CHUNK_CELL_COUNT = VXD_CHUNK_EDGE ** 3;
export const VXD_CELL_ORDER = "x-fastest-then-y-then-z" as const;
export const VXD_COORDINATE_SYSTEM = "right-handed-y-up" as const;

export const VXD_ATTRIBUTE_ENCODING = {
  albedo: "rgba8-srgb",
  normal: "octahedral-unorm8x2",
  material: "uint8",
  flags: "uint8",
} as const;

/** No per-cell flags are set. VXD v1 assigns no standard meaning to non-zero flag bits. */
export const VXD_CELL_FLAGS_NONE = 0 as const;

export type VxdVec3 = readonly [number, number, number];
export type VxdChunkCoordinateV1 = readonly [number, number, number];
export type VxdCellCoordinateV1 = readonly [number, number, number];
export type VxdRgba8 = readonly [number, number, number, number];
export type VxdUnitNormal = readonly [number, number, number];

/**
 * Attributes attached to one final occupied surface cell.
 *
 * The cell coordinate and occupancy bit already identify the post-displacement location. Attribute
 * records never move a cell. Texture inputs such as `heightSteps` must be resolved while a future
 * converter populates final occupied cells. `normal` is a unit vector in the chunk's local
 * coordinate system. `flags` is an opaque unsigned 8-bit field: VXD v1 assigns no standard bit
 * meanings, so producers should write zero unless a separate producer/consumer profile defines
 * them.
 */
export interface VxdCellAttributesV1 {
  readonly albedo: VxdRgba8;
  readonly normal: VxdUnitNormal;
  readonly material: number;
  readonly flags: number;
}

export interface VxdOccupiedCellV1 {
  readonly coordinate: VxdCellCoordinateV1;
  readonly attributes: VxdCellAttributesV1;
}

/** One independently encoded 8 x 8 x 8 chunk whose occupancy identifies final cell positions. */
export interface VxdChunkV1 {
  readonly coordinate: VxdChunkCoordinateV1;
  readonly cells: readonly VxdOccupiedCellV1[];
}

export interface VxdGridV1 {
  readonly chunkEdge: typeof VXD_CHUNK_EDGE;
  readonly cellSize: number;
  readonly origin: VxdVec3;
  readonly coordinateSystem: typeof VXD_COORDINATE_SYSTEM;
  readonly cellOrder: typeof VXD_CELL_ORDER;
}

/**
 * Logical document contract. VXD v1 intentionally defines no multi-chunk container encoding yet;
 * callers may store encoded chunks independently or provide their own indexed container.
 */
export interface VxdDocumentV1 {
  readonly kind: typeof VXD_KIND;
  readonly version: typeof VXD_VERSION;
  readonly grid: VxdGridV1;
  readonly attributes: typeof VXD_ATTRIBUTE_ENCODING;
  readonly chunks: readonly VxdChunkV1[];
}
