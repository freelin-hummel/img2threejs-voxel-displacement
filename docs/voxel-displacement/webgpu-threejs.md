# WebGPU and Three.js

[Index](README.md) · [Architecture](architecture-options.md) · [Conversion](conversion-pipeline.md) · [Sources](sources.md)

WebGPU can support the proposed object-local voxel traversal, but the project still needs a qualified implementation. Three.js’s current APIs make the integration plausible; they do not prove performance, compatibility, or fallback behavior for this workload.

## Current platform facts

- Three’s [WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html) prefers WebGPU and can select a WebGL2 backend.
- Custom WebGPURenderer materials must use [TSL](https://threejs.org/docs/TSL.html). ShaderMaterial, RawShaderMaterial, and onBeforeCompile modifications are not supported.
- [NodeMaterial](https://threejs.org/docs/pages/NodeMaterial.html) exposes `fragmentNode` for complete fragment logic and `depthNode` for an overridden fragment depth.
- TSL supports flow control, bit operations, storage resources, compute, and compilation to WGSL or GLSL.
- Official Three examples demonstrate [compute storage textures](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_texture.html), [storage buffers](https://threejs.org/examples/webgpu_storage_buffer.html), and [volume raymarching](https://threejs.org/examples/webgpu_volume_perlin.html).
- WebGPURenderer remains experimental in the official manual. Pin the Three revision and browser qualification target.

These are **established official API facts**. The renderer design below is **speculative for this fork** until exercised in the target browser.

WebGPU also requires a supported browser/device and an appropriate secure context. Capability detection must precede asset upload, and the selected adapter features and limits belong in the runtime receipt.

## Proposed per-object render path

### CPU and scene setup

For every voxel object:

1. create or reuse a unit box geometry matching the local voxel bounds;
2. attach a TSL node material;
3. upload object metadata, brick directory, masks, compact attributes, palettes, and transforms;
4. let Three perform ordinary object transforms, frustum culling, render order, and proxy rasterization;
5. retain the source mesh or fallback mesh under an explicit backend selection.

### Fragment traversal

The material should:

1. reconstruct a view ray for the current covered fragment;
2. transform origin and direction into object-local grid units;
3. robustly intersect the object AABB;
4. initialize top-level Amanatides–Woo DDA;
5. skip empty directory cells;
6. traverse a non-empty brick;
7. decode the first occupied cell’s compacted attribute index;
8. output color and shading attributes;
9. compute the hit’s clip-space depth and assign it through `depthNode`.

Every traversal loop needs a hard bound derived from validated dimensions. Reject malformed bundles, impossible offsets/counts, and dimensions that can exceed that bound before uploading them.

The same traversal should have diagnostic outputs for:

- object and brick bounds;
- number of top-level and fine steps;
- hit cell and face;
- occupancy/mask result;
- decoded normal;
- world and clip depth;
- LOD and fallback selection.

Those views are essential because a plausible color image can hide depth or traversal errors.

## Data layout

Start with 32-bit-addressable storage:

- object records aligned to storage-buffer requirements;
- one directory entry per top-level cell;
- occupancy masks as arrays of `u32`;
- compact attributes in structure-of-arrays or a measured packed format;
- palette/material tables shared when possible;
- separate ranges per object, clip, or page.

WGSL’s concrete integer types are `i32` and `u32`; the specification has no concrete `u64`. A 64-tree mask therefore needs two `u32` words and a population count over the lower word plus the relevant part of the upper word.

WGSL also disallows recursion, so SVO and 64-tree traversal must be iterative with a bounded explicit stack or stackless algorithm.

The [WebGPU specification](https://gpuweb.github.io/gpuweb/) defines baseline supported-limit values of 128 MiB for a storage-buffer binding and 256 MiB for a buffer. These are compatibility limits, not usable project budgets. Query the actual adapter limits, but page data so correctness never depends on optional larger limits.

## Compute versus fragment work

### Use compute for

- optional GPU conversion experiments;
- derived normals, AO, mip aggregation, or compression;
- full-screen voxel rendering when voxel content dominates the scene;
- debug counters and indirect object selection, if later needed.

### Use fragment traversal for

- the first per-object proxy renderer;
- integration with ordinary Three draw ordering and object transforms;
- restricting ray work to proxy-covered pixels;
- writing true voxel hit depth into the existing render.

Do not require GPU compute conversion for the first release. A CPU worker gives deterministic authority, cancellation, portable fixtures, and independent inspection.

## Depth and scene composition

The proxy box’s front face is not the visible voxel depth. The fragment shader must write the depth of the actual local voxel hit. Validate:

- ordinary mesh in front of the voxel object;
- ordinary mesh behind and intersecting its bounding box;
- two overlapping voxel objects;
- near-plane intersection and camera inside the bounds;
- reversed depth and logarithmic depth configurations if the host enables them;
- shadows and depth prepasses separately from the beauty pass.

Handle camera-inside, near-plane clipping, and front/back proxy faces explicitly. Writing fragment depth can reduce early-depth optimization, so measure its cost rather than inferring it from color correctness.

NodeMaterial also has shadow-related position and color hooks, but main-pass correctness does not automatically make voxel shadows work. Treat shadows, transparency, MSAA, motion vectors, and post-processing inputs as separate milestones.

## Fallback

The explicit fallback can be:

- instanced visible cubes for debugging and low counts;
- a greedy exposed-surface mesh for practical WebGL rendering;
- the original procedural/source mesh for far LOD or unsupported devices.

Backend selection should be observable:

    requested: auto | webgpu-voxel | webgl-voxel-mesh | source-mesh
    selected: concrete backend
    reason: capabilities, limits, asset support, or operator override

Never imply that WebGPURenderer’s WebGL2 backend automatically transpiles a storage-buffer or compute-dependent voxel path successfully. Test the fallback independently.

## Performance work

Measure before changing data structures:

- CPU conversion and packing time;
- source, peak intermediate, encoded, uploaded, and resident bytes;
- number of visible proxy pixels;
- average and p95 directory/fine DDA steps;
- storage reads and attribute decodes where tooling permits;
- GPU frame time at fixed render scale;
- shader compile/pipeline creation time;
- upload stalls and animation-frame switching cost.

GPU timestamp queries are optional adapter features. Record them when available and retain a CPU-side timing fallback with its lower precision stated.

Shader performance is likely to depend on coherent memory access, branch divergence, register pressure, stack size, and object screen coverage. Schroeder calls out memory layout and register use in his 64-tree renderer; his numbers remain author-reported and cannot be used as this project’s budget.

## Qualification matrix

| Gate | Minimum evidence |
| --- | --- |
| API compatibility | Pinned Three revision, browser, adapter, limits, and successful pipeline creation |
| Traversal correctness | Deterministic CPU ray oracle matched against GPU hit/miss, cell, face, and depth |
| Scene composition | Occlusion fixtures with ordinary and multiple voxel objects |
| Visual fidelity | Multi-angle source/voxel comparison plus thin-feature and seam views |
| Stability | Resize, context/device loss handling, dispose/recreate, clip switching |
| Performance | Fixed-resolution frame-time capture on named target hardware |
| Fallback | Forced WebGL/source path tested with explicit reason and visual evidence |

Public WebGPU examples demonstrating feasibility are annotated in [sources](sources.md). The portable asset contract and structure choices are in [architecture options](architecture-options.md).
