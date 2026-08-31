# Architecture options

[Index](README.md) · [Foundations](foundations.md) · [Conversion](conversion-pipeline.md) · [WebGPU](webgpu-threejs.md)

There is no universally best voxel representation. Storage cost, traversal cost, conversion speed, editability, attribute density, animation, streaming, and target hardware pull in different directions. The first implementation should optimize for a correct, inspectable object pipeline rather than maximum theoretical compression.

## Representation matrix

| Representation | Strengths | Weaknesses | Best fit here | Evidence |
| --- | --- | --- | --- | --- |
| Dense 3D grid | Simplest indexing and DDA; easy validation | Cubic memory growth; uploads waste empty space | Tiny fixtures and reference implementation | **Established** |
| Instanced visible cubes | Fits ordinary Three.js scene flow; simple fallback | High instance/vertex bandwidth; weak for very fine voxels | Compatibility and correctness fallback | **Established** |
| Greedy surface mesh | Fast conventional rasterization; compact exposed faces | Rebuild cost; loses direct voxel traversal semantics | WebGL fallback and far LOD | **Established** |
| Top grid plus dense bricks | Simple construction, edits, paging, and two-level DDA | Directory overhead; less compression than trees | Recommended MVP | **Demonstrated in roxlap/VoxelRT; speculative choice here** |
| Sparse voxel octree | Compresses empty space; mature traversal literature | Pointer/layout complexity; updates and attributes are harder | Profile-driven second implementation | **Established** |
| Sparse 64-tree | Shallower hierarchy and wide bitmask locality | No native WGSL u64; community evidence is hardware-specific | Candidate after brick-map baseline | **Demonstrated by Schroeder and the public 64-tree guide; speculative here** |
| SVDAG | Strong deduplication for repeated static occupancy | Expensive construction; awkward mutable/animated attributes | Large immutable static scenes | **Established** |
| NanoVDB-style hierarchy | Portable, linearized, GPU-friendly sparse volume | Complex format and integration; read-only topology | Interchange or very large static volumes | **Established** |
| Full-screen compute ray caster | Flexible whole-scene traversal and post pipeline | Must compose scene depth and multiple objects explicitly | Later dedicated voxel renderer | **Demonstrated in public WebGPU/WGPU projects; speculative here** |
| Per-object proxy rasterization | Uses Three frustum/raster coverage; local transforms; true voxel hits | One traversal shader per covered fragment; depth must be correct | Recommended runtime path | **Demonstrated by Schroeder for voxelized objects; speculative Three integration here** |

## Recommended hybrid

The following layout, bundle schema, paging scheme, and LOD policy are **speculative project decisions**. They are selected because established structures and public implementations make them plausible, not because they have been reproduced in this checkout.

Use one voxel grid per object or rigid component:

1. A compact object table stores bounds, world/object transforms, brick-directory offsets, attribute offsets, current frame, and LOD.
2. An object-local top-level grid stores an empty marker or index for each non-empty 8³ brick.
3. Every brick stores a 512-bit occupancy mask.
4. Attributes are compacted in occupancy-bit order rather than allocating them for empty cells.
5. A bounding-box proxy invokes local-space two-level DDA and writes the hit’s color, normal, material response, and depth.
6. The original object remains available for collision, interaction, debugging, and an explicit fallback.

This design is intentionally compatible with later changes:

- replace a large object’s directory with an SVO or 64-tree without changing its semantic contract;
- deduplicate identical bricks or animation frames;
- page object or brick ranges to respect GPU binding limits;
- generate greedy meshes from the same occupancy data;
- aggregate coarser bricks for LOD.

## Current chunk contract and proposed bundle

The implemented `integrations/voxel_displacement/` VXD v1 package currently defines a logical
document and independently encoded chunks. Each fixed 8³ chunk contains:

    chunk coordinate: little-endian i32 x 3
    occupancy: 512 bits in x-fastest order
    occupied-cell attributes, in occupancy-bit order:
      albedo: RGBA8 sRGB
      normal: octahedral UNORM8 x 2
      material: u8 slot
      flags: u8, zero unless a separate profile defines bits

It does not yet define a multi-chunk file container, source provenance envelope, palettes, clips, or
renderer metadata. Occupancy is the final post-displacement location; a future cell-population step
must resolve texture height steps before encoding rather than asking traversal to move a hit. The
Python texture bake does not yet populate these chunks.

A future canonical bundle should remain renderer-independent and deterministic. One proposed
envelope is:

    VxdManifestV1
      version: 1
      kind: heightfield | displaced-surface | voxel-object | animated
      source: hash, name, converter version
      grid: origin, dimensions, voxel size, chunk size
      palettes: colors and material styles
      chunks: binary URI, count, encoding
      clips: optional sampled-frame metadata
      collision: optional source-mesh URI
      recipe: complete conversion options
      warnings: structured findings

Palette indexing, standardized flag meanings, AO, richer materials, and a source/provenance manifest are potential later
schema additions, not fields in the implemented VXD v1 cell record. If palettes are added, keep
visible color and material style separate so equal colors can still differ in roughness, emissive
behavior, or flags.

## Rendering choices

### Reference and fallback renderer

Build an instanced-cube or greedy-surface path first enough to inspect the converted data independently of traversal code. This is also the compatibility route for WebGL-only devices.

It must be an explicit backend choice. Three.js WebGPURenderer having a WebGL2 backend does not prove that a storage-buffer traversal written for WebGPU can run there.

### Per-object proxy renderer

For each visible object:

1. Rasterize its local bounding box.
2. Reconstruct the camera ray and transform it into object-local grid units.
3. Intersect the ray with the local bounds.
4. DDA through the top-level directory.
5. When a non-empty brick is entered, DDA through its cells.
6. On the first occupied cell, decode compacted attributes using population count.
7. shade the hit and write its scene-compatible depth.

This delegates frustum coverage and object transforms to Three while keeping voxel traversal in the shader.

### Full-screen compute

A compute renderer becomes attractive when the scene is dominated by voxel content, needs global traversal, or uses custom multi-bounce lighting. It also assumes responsibility for ordinary-mesh depth composition, transparency ordering, multiple object acceleration, and presentation. It is a later architecture, not a prerequisite.

## Attribute strategy

Occupancy and geometry compression must not dictate shading representation:

- use source-interpolated normals where a detailed triangle mesh exists;
- use height gradients for sub-voxel displacement detail;
- fall back to occupancy-derived normals when only a voxel volume exists;
- reserve a normal-range or cone encoding for one-voxel thin features after visual evidence proves a single normal inadequate;
- store material style separately from palette color;
- treat transparency and transmission as explicit feature gates.

## LOD and streaming

For an object-focused first release:

- build complete per-object mip levels offline;
- aggregate coverage rather than choosing one arbitrary child;
- filter albedo and normals with coverage weighting;
- preserve identity-critical thin parts using an authored or measured retention rule;
- select a coarser voxel grid or source-mesh far LOD per object;
- load and evict object bundles, not individual voxels.

Move to ray-guided brick streaming only when an actual world-scale working set exceeds the target GPU memory budget. GigaVoxels and Aokana are research references, not MVP requirements; see [sources](sources.md).

## Decision rules

Choose the simplest structure that clears measured gates:

- Start dense for tiny fixtures.
- Start brick-mapped for real objects and baked animation.
- Add a 64-tree or SVO when empty-space traversal or directory memory is a measured bottleneck.
- Add SVDAG compression only for static/repetitive data whose build latency and attribute scheme are acceptable.
- Add temporal compression only after correct baked animation exceeds a stated memory budget.
- Add streaming only after representative scenes exceed a resident-set budget.

The corresponding converter stages are in [conversion pipeline](conversion-pipeline.md), and shader constraints are in [WebGPU and Three.js](webgpu-threejs.md).
