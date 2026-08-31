# Voxel-displacement-inspired research

This wiki is the design and evidence hub for adding a voxel-displacement-inspired path to img2threejs.

The name is deliberately qualified. Daniel Schroeder has published the visual goals, constraints, selected data-structure details, and performance observations of his renderer, but not the preprocessing or rendering implementation for its arbitrary-mesh displacement system. This project can independently reproduce and test the disclosed ideas; it must not describe itself as a port, clone, or exact implementation.

## Start here

| Page | Use it when |
| --- | --- |
| [Foundations and terminology](foundations.md) | Aligning on what “voxel displacement” means and separating established techniques from project hypotheses. |
| [Architecture options](architecture-options.md) | Choosing brick maps, SVOs, 64-trees, SVDAGs, proxy rendering, or raster fallbacks. |
| [Conversion pipeline](conversion-pipeline.md) | Turning textures, procedural Three.js geometry, GLB/glTF, or OBJ into deterministic voxel assets. |
| [Animation](animation.md) | Preserving rigid hierarchy or baking skinned and morphed animation into voxel frames. |
| [WebGPU and Three.js](webgpu-threejs.md) | Implementing storage, traversal, depth, TSL materials, and a qualified fallback. |
| [Sources and evidence](sources.md) | Reviewing primary papers, official documentation, public prototypes, licenses, and evidence labels. |
| [Cross-project adoption](cross-project-adoption.md) | Moving the capability into another project without copying hidden assumptions or unverified claims. |
| [Runtime evidence](runtime-evidence.md) | Reproducible SceneProof receipt for the static OBJ-to-VXD proxy slice. |

## What the evidence supports

Schroeder’s public work separates two representations:

1. Large, mostly static environment surfaces use low-poly UV meshes plus albedo and displacement maps. Geometry is displaced in whole voxel steps, while unquantized height still contributes to shading normals.
2. Small, thin, highly curved, or animated objects use conventional surface-only voxel meshes baked from detailed triangle meshes. Animated characters switch among separately voxelized poses like sprite frames.

The practical implication is a multi-track fork, not a universal “voxelize” filter:

| Input class | Recommended first route |
| --- | --- |
| Plane, terrain, or controlled primitive with a height map | Project-proposed quantized heightfield renderer. |
| Static, manifold, UV-mapped environment mesh | Experimental narrow-band surface displacement with strict topology, thickness, curvature, and UV gates. |
| Prop, foliage, thin feature, arbitrary static mesh | Conservative surface voxelization. |
| Rigid hierarchy | Voxelize each rigid part once and preserve node transforms. |
| Skinned or morphed character | Bake selected posed frames into one shared object-local grid. |

## Recommended first architecture

The conversion and proxy items called out below are now partially implemented and qualified only at
the CPU/reference level. The production traversal items remain **speculative project design** until
implemented and qualified in this checkout. Schroeder disclosed bounding-box plus 64-tree traversal
for voxelized objects, not for his unpublished environment-displacement path.

The first complete vertical slice should:

- keep the original Three.js object, hierarchy, rig metadata, pivots, sockets, and colliders as source and gameplay authority;
- conservatively bake one static OBJ object to surface voxels in the forge (worker cancellation is
  still open);
- store occupancy and shading attributes in object-local 8³ bricks behind a compact top-level directory;
- render a bounding-box proxy whose TSL fragment logic performs two-level DDA and writes the actual hit depth;
- retain an explicit raster fallback for browsers or devices that cannot run the storage-buffer traversal;
- validate silhouettes, thin features, material boundaries, normals, depth composition, memory, and frame time in a real browser.

This deliberately postpones SVDAG compression, open-world streaming, live revoxelization, and smooth voxel-space skinning until evidence shows they are needed.

## Evidence language

Every technical claim in this wiki uses one of these statuses:

- **Established** — supported by peer-reviewed research, a standards specification, or authoritative official documentation.
- **Demonstrated** — shown in public source or an author’s working prototype, but not established as a general result.
- **Speculative** — a proposed application to this fork that still needs implementation and runtime qualification.

Performance numbers from blog posts and public repositories remain author-reported unless independently reproduced. A green build is not rendering acceptance, and a screenshot alone does not prove correct depth, animation, or traversal behavior.

## Initial acceptance target

A first milestone is credible only when all of the following are true:

- the same source and options produce byte-identical voxel data;
- conservative voxelization preserves required thin features without random sampling holes;
- source and voxel views pass multi-angle silhouette and material-region comparisons;
- the voxel hit depth correctly composes with ordinary Three.js meshes;
- cancellation and conversion progress work without blocking the main thread;
- the fallback path is selected explicitly and tested independently;
- browser evidence records target device, browser, Three.js revision, resolution, voxel count, GPU memory, and frame time;
- source provenance, conversion recipe, warnings, and unsupported material/animation features ship with the asset.

The current static-OBJ/Three.js reference evidence is a useful Level 2–3 checkpoint, not the initial
acceptance target: it still lacks worker cancellation, scene-depth composition, GLB/animation
conversion, and GPU traversal evidence. Continue with [foundations and terminology](foundations.md),
then use the decision matrix in [architecture options](architecture-options.md).
