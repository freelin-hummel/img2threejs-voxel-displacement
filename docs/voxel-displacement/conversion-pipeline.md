# Conversion pipeline

[Index](README.md) · [Foundations](foundations.md) · [Architecture](architecture-options.md) · [Animation](animation.md)

The converter should have distinct routes with shared analysis, provenance, material sampling, codec, and validation. “Auto” means choose a compatible route or reject with findings; it must not force every source through displacement.

## Current repository slice

The current deterministic helpers implement planning, a texture-field bake, and a static OBJ
surface-to-VXD bridge:

- `forge/stage1_intake/plan_voxel_displacement.py` probes prompt, OBJ, GLB, albedo, and height inputs and chooses a route.
- `forge/stage3_build/bake_voxel_displacement.py` writes continuous 8-bit height, signed whole-voxel steps, an octahedral normal field, optional RGBA albedo, provenance, hashes, and an honesty statement.
- `forge/stage3_build/voxelize_obj.py` and `forge/_shared/voxel_mesh.py` parse static OBJ triangles,
  resolve optional height steps along source normals before occupancy, conservatively mark touched
  cells with a triangle-box SAT, sample albedo at the closest triangle point, and emit final VXD
  logical chunks with source hashes and budgets.
- `forge/_shared/voxel_displacement.py` holds the compressed-channel codec, height-field logic, and ImageGen reference brief.
- `integrations/voxel_displacement/` defines and tests the separate VXD v1 logical document and deterministic 8³ binary chunk codec.
- `integrations/voxel_displacement/reference/scene.js` renders final VXD cells through a Three.js
  `InstancedMesh` proxy; the manual page and SceneProof command provide a source-grounded visual check.

The texture-bake JSON and binary VXD chunks are deliberately different artifacts. Static OBJ
population is now implemented, but this remains a bounded reference converter rather than a general
GLB/object runtime: GLB buffer extraction, animation pose baking, binary multi-chunk packaging, and
WebGPU traversal are still open.

Two current semantics must remain explicit:

- Height currently uses the declared `raw-rgb-data-bt709-luma-u8` interpretation: BT.709 weights applied directly to decoded 8-bit RGB values. It is a deterministic weighted-encoded-RGB heuristic, not linear-light luminance and not a physically calibrated displacement. A real height map should be treated as data with explicit channel, transfer function, zero level, sign, amplitude, units, and inversion.
- `surfaceNormalOct8` currently comes from clamped texture-space finite differences. Without target world dimensions, texel aspect, UV density, edge/wrap mode, tangent convention, and displacement-axis convention, it is a provisional bake field rather than a seamless, final world-space normal field.
- Current nearest-step conversion uses Python’s round-to-nearest, ties-to-even behavior. Any cross-language decoder or rebaker must name and test the same tie rule.

OBJ and GLB probes are routing evidence. They do not yet prove minimum thickness, consistent orientation, absence of self-intersections, safe curvature, animation bakeability, or full material support.

## Conversion modes

| Mode | Required input | Algorithm | Typical use |
| --- | --- | --- | --- |
| `heightfield` | Height plus optional albedo and a declared projection | Quantized height columns or tangent-space traversal | Plane, terrain, box face, controlled primitive |
| `surface-displacement` | Static UV mesh plus height | Narrow-band signed or oriented pseudo-distance field displaced by sampled height | Walls, terrain, arches, large environment pieces |
| `surface-shell` | Triangle mesh and materials | Conservative triangle/box surface voxelization | Props, foliage, thin parts, arbitrary object shape |
| `solid-object` | Closed triangle mesh | Conservative shell plus robust interior classification/fill | Destruction, cutting, volume queries |
| `baked-frames` | Skinned/morphed mesh plus selected clips | Pose, voxelize each sampled frame into one shared grid | Sprite-like character animation |

## 1. Load and canonicalize

Prefer GLB/glTF because it can carry hierarchy, skins, morph targets, PBR materials, texture transforms, and animations. OBJ is suitable for static geometry but does not preserve rig or animation semantics.

Canonicalization should:

- resolve a stable source hash and converter version;
- retain the source root pivot and all rigid-node transforms;
- handle negative-determinant transforms without silently reversing surfaces;
- triangulate only by a deterministic rule;
- choose one object-local coordinate system;
- anchor every animation frame to the same grid;
- record every approximation and rejected extension.

Relevant APIs are Three’s [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), [OBJLoader](https://threejs.org/docs/pages/OBJLoader.html), [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html), and [SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html).

## 2. Analyze before conversion

Produce structured findings for:

- degenerate triangles and UV triangles;
- boundary, non-manifold, and inconsistently oriented edges;
- self-intersection candidates;
- missing normals, UVs, tangents, colors, or texture coordinates;
- UV seams, overlap, wrap mode, texture transforms, and texel-density range;
- minimum estimated thickness versus maximum inward displacement;
- curvature versus requested shell width;
- skins, morph targets, rigid-node animation, material animation, and frame count;
- alpha mode, transmission, volume, UDIM, and compressed-texture requirements;
- dense and estimated compressed memory before allocation.

A closed, consistently oriented mesh can use a signed-distance route. An open but oriented terrain or sheet can use an unsigned narrow band only when nearest-surface orientation is unambiguous. Non-manifold, intersecting, thin, or animated geometry should route to conservative surface voxelization.

The [OpenVDB MeshToVolume API](https://github.com/AcademySoftwareFoundation/openvdb/blob/master/openvdb/openvdb/tools/MeshToVolume.h) documents the same useful signed/closed versus unsigned/open distinction. [Generalized winding numbers](https://users.cs.utah.edu/~ladislav/jacobson13robust/jacobson13robust.html) are a robust longer-term sign strategy, not a browser-MVP dependency.

## 3. Define the grid

Accept exactly one scale authority:

- `voxelSize` in model/world units, or
- `longestAxisVoxels`.

Derive and record dimensions, padding, origin, transforms, and memory estimates. Reject non-finite values and allocations above the selected budget before constructing a dense intermediate.

For animation, the grid is clip-independent and rest anchored. Bounds should cover every selected sample plus padding; per-frame recentering causes visible jitter and breaks frame deduplication.

## 4. Build occupancy

### Conservative object surface

For each triangle:

1. transform it into voxel-grid coordinates;
2. compute its integer voxel AABB;
3. test every candidate cell with a separating-axis triangle/box overlap test;
4. mark every touched cell;
5. retain enough triangle/barycentric information to sample attributes deterministically.

This has a clear correctness definition and preserves thin features better than random surface sampling. Primary references are [Akenine-Möller’s triangle-box test](https://doi.org/10.1145/1198555.1198747) and [Fast Parallel Surface and Solid Voxelization](https://michael-schwarz.com/research/publ/files/vox-siga10.pdf).

Three’s [MeshSurfaceSampler](https://threejs.org/docs/pages/MeshSurfaceSampler.html) can provide deterministic diagnostic probes, but random area-weighted samples must not define canonical occupancy.

### Displaced surface

One independent formulation for a closed or safely oriented mesh is:

    closest = closest point and source triangle for grid sample x
    d       = signed or consistently oriented distance from x to base surface
    uv      = barycentric interpolation on closest.triangle
    h       = decodedHeight(uv) * declaredWorldAmplitude
    F(x)    = d - h

A cell intersects the displaced surface when `F` changes sign across its corners or when its minimum absolute value falls below a conservative cell threshold. Sharp-feature crack closure may additionally use conservative shell occupancy.

This is a project hypothesis informed by established distance-field and shell techniques. It is not Schroeder’s unpublished algorithm.

For CPU browser work, [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) offers closest-point queries, worker construction, posed static geometry generation, and useful SDF examples. Pin its version and verify behavior for centered geometry, morph targets, and skinning.

## 5. Sample materials and detail

At the selected source triangle:

- interpolate UV, vertex color, and source shading normal;
- honor texture transform, wrap mode, selected UV set, material factors, and alpha mode;
- decode base color and emissive according to sRGB rules;
- keep metallic, roughness, normal, occlusion, and height as data;
- define normal-map Y convention and use a qualified tangent basis;
- quantize geometric height to whole voxel steps;
- derive lighting normals from unquantized height or detailed source geometry.

The [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) is authoritative for glTF material and color-space behavior. glTF has no ratified geometry-displacement material property in its [extension registry](https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md), so displacement semantics belong in the conversion recipe.

The recipe must name:

- source channel and transfer function;
- zero/midpoint and sign;
- world or model units per source unit;
- inversion;
- edge mode: clamp, repeat, mirror, or border;
- texture origin and normal-map Y convention;
- finite-difference scale and target texel aspect;
- signed-integer representation;
- quantization tie rule.

## 6. Encode a deterministic bundle

Use the renderer-independent contract in [architecture options](architecture-options.md). At minimum, record:

- source and dependency hashes;
- converter/schema version;
- grid transform and dimensions;
- exact options and routing decision;
- occupancy and attribute hashes;
- unsupported or approximated features;
- optional source collision asset;
- animation sample times and root motion;
- validation metrics.

MagicaVoxel VOX and BINVOX may be interchange outputs, but neither carries the full normal, material, displacement-recipe, hierarchy, and animation contract needed here.

## 7. Validate

### Deterministic gates

- byte-identical decoded semantic channels for identical source/options with pinned converter, decoder, and codec versions;
- triangle/cell contact, grazing, degeneracy, winding, and boundary fixtures;
- codec bounds, hashes, signed-step decoding, and malformed-data rejection;
- UV transform, wrap, mirrored UV, alpha mask, and material-seam fixtures;
- cancellation, progress, time, and peak-memory receipts.

### Geometry and appearance gates

- bidirectional distance between expected surface and occupied cells;
- multi-view silhouette intersection-over-union;
- identity-critical thin-feature retention;
- palette median and p95 color error;
- normal angular error;
- UV seam and hard-corner views;
- correct composition against ordinary scene depth.

### Animation gates

- shared grid origin and dimensions;
- stable ground contact and facing direction;
- expected frame-to-frame variation;
- root-motion preservation;
- no unexplained temporal jitter;
- measured per-clip and total memory.

Use Khronos [glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) and the [glTF Asset Generator](https://github.com/KhronosGroup/glTF-Asset-Generator) for standards fixtures.

Whole JSON artifacts may include absolute paths or platform-specific decoder metadata. Canonicalize that metadata before requiring whole-artifact byte identity; otherwise compare decoded semantic-channel hashes.

## Staged delivery

1. **Contract slice:** current planner and texture-field bake, corrected documentation semantics, deterministic fixtures, and explicit renderer-neutral artifact.
2. **Static object slice:** conservative static-OBJ surface voxelizer, compact 8³ chunks, source attributes, Three.js reference proxy, and round trip (implemented; GLB and worker cancellation remain).
3. **Renderer slice:** proxy-box WebGPU traversal, true depth, browser evidence, and explicit fallback.
4. **Static displacement slice:** controlled heightfield projection, then gated manifold narrow-band experiments.
5. **Animation slice:** rigid hierarchy first, then fixed-rate baked skinned/morphed frames.
6. **Scale slice:** LOD aggregation, structure bakeoff, frame deduplication, and streaming only after profiling.

Runtime implementation constraints are in [WebGPU and Three.js](webgpu-threejs.md); animation details are in [animation](animation.md).
