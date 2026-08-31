# Voxel displacement integration (VXD v1 foundation)

This isolated package defines the renderer-neutral data boundary for the voxel-displacement fork.
It has no runtime dependencies and imports no Three.js, WebGL, WebGPU, engine, image, or mesh code.

## Implemented

- Typed Voxel Displacement Data (`VXD`) version 1 document, grid, chunk, cell, and attribute contracts.
- Fixed `8 x 8 x 8` chunks with x-fastest cell indexing.
- Deterministic little-endian chunk encoding:
  - a 24-byte header;
  - a 64-byte occupancy bitset for all 512 cells;
  - one 8-byte attribute record per occupied cell, ordered by canonical cell index.
- Runtime validators with structured error codes and non-blocking canonical-order/empty-data warnings.
- A strict decoder that rejects unsupported flags, truncation, trailing bytes, and occupancy/count drift.
- Focused Node tests using the built-in `node:test` runner.

Each occupied-cell attribute record contains:

| Bytes | Channel | Encoding |
| --- | --- | --- |
| 0-3 | albedo | RGBA8, sRGB |
| 4-5 | normal | octahedral UNORM8 x 2 |
| 6 | material | unsigned 8-bit slot |
| 7 | flags | unsigned 8-bit opaque bitfield |

Occupancy is spatial and final in VXD v1. An occupied bit and its cell coordinate identify the
post-displacement cell that traversal code tests; readers must not apply a second displacement.
Per-cell `flags` do not move cells. VXD v1 assigns no standard meaning to non-zero flag bits, so
producers should write zero unless a separate producer/consumer profile defines them.

The complete chunk layout is:

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `VXD1` |
| 4 | 1 | chunk edge, always `8` |
| 5 | 1 | attribute stride, always `8` |
| 6 | 1 | chunk flags, zero in v1 |
| 7 | 1 | reserved, zero |
| 8 | 12 | signed little-endian chunk x/y/z (`int32`) |
| 20 | 2 | occupied-cell count (`uint16`) |
| 22 | 2 | reserved, zero |
| 24 | 64 | occupancy bitset; bit `x + 8 * (y + 8 * z)` |
| 88 | `8 * count` | occupied-cell attributes in ascending bit-index order |

## Not implemented yet

This package does **not** yet voxelize triangle meshes, populate VXD chunks from the forge texture
bake, build animation-frame chunks, stream or compress a multi-chunk container, select LODs, upload
GPU buffers, draw voxels, or integrate with the img2threejs generator/showcase. The repository's
Python forge can already create renderer-neutral height, whole-step, normal, and albedo channels;
the bridge from those 2D channels to occupied VXD cells remains a separate implementation step.
During that future cell-population step, texture `heightSteps` must be resolved into final occupied
cell coordinates, including any collision/deduplication policy. `heightSteps` is conversion input;
it is not stored as a post-occupancy displacement attribute in VXD v1. No visual result or renderer
performance claim follows from these contracts and codec tests.

Those later layers should consume VXD rather than changing its meaning for a particular renderer:

```text
procedural source mesh + independent material maps
  -> forge displacement texture bake (implemented for height/albedo textures)
  -> mesh projection / surface voxelization resolves heightSteps into final cells (not implemented)
  -> validated VXD chunks (implemented here)
  -> renderer adapter / animation player (not implemented)
```

## Development

Requires Node.js 20 or newer. The only development dependency is TypeScript.

```bash
npm install
npm run check
```
