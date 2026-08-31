# Sources and evidence

[Index](README.md) · [Foundations](foundations.md) · [Architecture](architecture-options.md) · [WebGPU](webgpu-threejs.md)

Labels:

- **Established** — peer-reviewed research, a standards specification, or authoritative official documentation.
- **Demonstrated** — public source or an author’s working prototype, without a general guarantee.
- **Speculative** — a proposed use in this fork that still needs implementation and runtime evidence.

Performance claims below remain scoped to the cited authors’ hardware and workloads unless this repository reproduces them.

Last reviewed: 2026-08-30. GitHub repositories, default-branch files, Three.js examples, registries, and license displays are mutable; an implementation or adoption record must capture the exact commit/revision it used. The “no ratified displacement extension” observation is current only as of this review date.

## Daniel Schroeder

### [Voxel Displacement Renderer — Modernizing the Retro 3D Aesthetic](https://blog.danielschroeder.me/blog/voxel-displacement-modernizing-retro-3d/)

**Demonstrated by the author.**

Discloses:

- low-poly UV triangle meshes, shading normals, albedo, and displacement as the environment-authoring inputs;
- CPU preprocessing of scene geometry and texture-derived information;
- whole-voxel displacement for visible geometry plus continuous-height normals for sub-voxel lighting;
- a relationship to shell mapping;
- manifold, though not necessarily closed, mesh requirements and other undisclosed authoring constraints;
- use of the original triangle meshes for collision and ordinary gameplay;
- a standalone C++/Vulkan implementation and author-reported RX 5700 XT and Steam Deck performance.

Does not disclose the exact shell parameterization, edge/corner machinery, data layout, traversal, source, or license. An independent project may reproduce published principles, not claim a port or exact implementation.

### [Voxel Displacement Renderer — Where This Goes From Here](https://blog.danielschroeder.me/blog/voxel-displacement-where-this-goes/)

**Demonstrated renderer context; speculative author-proposed integration plans.**

Supports engine integration rather than a voxel-native game architecture: art authoring changes, while logic, UI, movement, physics, AI, and navigation can remain conventional. Identifies smaller objects, enemies, non-rigid animation, shadows, and richer lighting as unfinished at that date. It also explains why the author did not intend a generic asset-store or open middleware release.

### [Voxel Renderer — Handling Objects and Animated Characters](https://blog.danielschroeder.me/blog/voxel-renderer-objects-and-animation/)

**Demonstrated by the author.**

Adds a second path:

- detailed off-the-shelf triangle meshes are baked into surface-only voxel meshes;
- selected animated poses are exported, voxelized independently, and frame-swapped without interpolation;
- detailed source geometry supplies per-voxel normals and crevice cues;
- one-cell thin features use a normal range approximating curved behavior;
- each object’s bounding box is rasterized and a hierarchical DDA traverses a sparse 64-tree in the fragment shader;
- baking time, VRAM, and frame-time numbers are author-reported.

The post still does not publish implementation source.

## Core structures and traversal

| Source | Label | What it supports |
| --- | --- | --- |
| [A Fast Voxel Traversal Algorithm for Ray Tracing](https://www.cse.yorku.ca/~amana/research/grid.pdf) | **Established** | Uniform-grid DDA and its low per-step arithmetic cost. |
| [Efficient Sparse Voxel Octrees](https://research.nvidia.com/publication/2010-02_efficient-sparse-voxel-octrees) and [extended technical report](https://research.nvidia.com/publication/2010-02_efficient-sparse-voxel-octrees-analysis-extensions-and-implementation) | **Established** | Compact SVO layout, efficient ray casting, contour/normal data, filtering, hierarchy construction, and beam optimization. |
| [High Resolution Sparse Voxel DAGs](https://doi.org/10.1145/2461912.2462024) | **Established** | Deduplicating identical SVO subtrees and traversing the result without decompression. |
| [Geometry and Attribute Compression for Voxel Scenes](https://doi.org/10.1111/cgf.12841) | **Established** | Separating topology compression from palette-compressed color, normal, and reflectance attributes. |
| [Hybrid Voxel Formats for Efficient Ray Tracing](https://arxiv.org/abs/2410.14128) and [source](https://github.com/RArbore/illinois-voxel-sandbox) | **Demonstrated research and source** | Tested hybrids mix raw-grid, distance, SVO, and SVDAG levels; generalization to this workload still needs profiling. |
| [NanoVDB paper](https://research.nvidia.com/labs/prl/nanovdb/nanovdb2021.pdf) and [HDDA API](https://academysoftwarefoundation.github.io/openvdb/HDDA_8h.html) | **Established** | Linearized pointerless sparse grids and hierarchical empty-space skipping for static volumes. |
| [GigaVoxels](https://www.icare3d.org/research-cat/publications/gigavoxels-ray-guided-streaming-for-efficient-and-detailed-voxel-rendering.html) | **Established** | Ray-guided brick production/streaming, adaptive resolution, and mip-style filtering for data larger than GPU memory. |
| [Aokana](https://arxiv.org/abs/2505.02017) | **Demonstrated research/preprint** | Segmented SVDAG, GPU-driven LOD, and streaming for open-world scale; not required for object MVPs. |

## Voxelization and rendering implementations

| Source | Label | What it supports |
| --- | --- | --- |
| [Fast Parallel Surface and Solid Voxelization on GPUs](https://michael-schwarz.com/research/publ/files/vox-siga10.pdf) | **Established** | Conservative connected surface voxelization, solid voxelization, and sparse construction from triangles. |
| [Akenine-Möller triangle-box overlap test](https://doi.org/10.1145/1198555.1198747) | **Established** | A deterministic triangle/cell contact primitive for conservative CPU baking. |
| [A Ray-Box Intersection Algorithm and Efficient Dynamic Voxel Rendering](https://jcgt.org/published/0007/03/04/) | **Established, workload-specific** | Efficient oriented box intersection and direct voxel rendering; includes GLSL and comparative measurements. |
| [Sparse 64-tree guide](https://dubiousconst282.github.io/2024/10/03/voxel-ray-tracing/) and [VoxelRT](https://github.com/dubiousconst282/VoxelRT) | **Demonstrated community research** | Concrete wide-tree layout, traversal, shader debugging, and comparisons with brick maps and ESVO. Results are hardware-specific. |
| [webgpu-voxel-raymarching](https://github.com/jamestkiernan/webgpu-voxel-raymarching) | **Demonstrated** | MIT-licensed browser WGSL DDA plus dense octree and packed 3D texture. Reported performance is not an independent benchmark. |
| [roxlap](https://github.com/NCrashed/roxlap) | **Demonstrated** | Dual MIT/Apache clean-room WGPU/WGSL brick-map renderer with two-level DDA, object grids, LOD, streaming, and voxel clips. |

## Displacement and shading

| Source | Label | What it supports |
| --- | --- | --- |
| [Shell Maps](https://web.cs.ucdavis.edu/~porumbes/Pubs/shellmaps_siggraph2005.pdf) | **Established** | A bijective volumetric mapping between base and offset surfaces for silhouette-affecting detail. |
| [Generalized Displacement Maps](https://diglib.eg.org/items/703fc834-30a6-46dc-b766-70de034c68db) | **Established** | Direction-dependent non-heightfield mesostructure, visibility, and shadows at substantial storage/precompute cost. |
| [Per-Pixel Displacement Mapping with Distance Functions](https://download.nvidia.com/developer/GPU_Gems_2/GPU_Gems2_ch08.pdf) | **Established** | Distance-assisted per-pixel heightfield intersection. It does not solve arbitrary mesh shell mapping. |
| [Heightmap Voxel Traversal shader](https://godotshaders.com/shader/heightmap-voxel-traversal/) | **Demonstrated** | CC0 tangent-space heightmap DDA, quantized levels, several normal modes, and optional depth. The author calls it a simpler starting point, not Schroeder’s algorithm. |
| [Voxel DSS](https://github.com/DanFessler/voxel-dss) | **Demonstrated research prototype** | Occupancy-gradient/centroid normals and AO that preserve cube silhouettes while implying smoother form. Only identified core voxel files carry MIT headers; the editor app is excluded. |
| [Micro-Mesh Construction](https://research.nvidia.com/publication/2023-08_micro-mesh-construction) and [Vulkan displacement micromap](https://docs.vulkan.org/refpages/latest/refpages/source/VK_NV_displacement_micromap.html) | **Established, not a WebGPU route** | Compact hardware displacement microgeometry. The Vulkan extension is provisional and deprecated. |

The project’s proposed narrow-band displaced-field algorithm, arbitrary hard-corner behavior, and TSL heightfield implementation are **speculative** until built and qualified.

## Animation

| Source | Label | What it supports |
| --- | --- | --- |
| Schroeder’s [objects and animation post](https://blog.danielschroeder.me/blog/voxel-renderer-objects-and-animation/) | **Demonstrated** | Surface-only pose baking and sprite-like frame switching. |
| [Efficient Animation of Sparse Voxel Octrees for Real-Time Ray Tracing](https://arxiv.org/abs/1911.06001) | **Demonstrated research/preprint** | Translation, rotation, and anisotropic scaling while retaining SVO hierarchy; not ordinary smooth skinning. |
| [VoxelRenderer](https://github.com/nieznanysprawiciel/VoxelRenderer) | **Demonstrated experimental implementation** | Animated shell rasterization plus inverse ray transforms into a static bind-pose SVO. Old DirectX/FBX prototype. |
| [Exploiting Coherence in Time-Varying Voxel Data](https://www.cse.chalmers.se/~uffe/exploiting_coherence_in_time-varying_voxel_data.pdf) | **Established research** | Temporal DAG sharing and compressed storage across voxel frames. |

Live per-frame WebGPU voxelization, arbitrary blend trees, and smooth voxel-space skinning are **speculative**.

## Three.js, WebGPU, and asset standards

| Source | Label | What it supports |
| --- | --- | --- |
| [Three WebGPURenderer docs](https://threejs.org/docs/pages/WebGPURenderer.html) and [manual](https://threejs.org/manual/en/webgpurenderer) | **Established official documentation** | WebGPU preference, WebGL2 backend selection, experimental status, and migration constraints. |
| [TSL specification](https://threejs.org/docs/TSL.html) | **Established official documentation** | Shader flow control, storage, compute, bit operations, and WGSL/GLSL generation. |
| [NodeMaterial](https://threejs.org/docs/pages/NodeMaterial.html) | **Established official documentation** | Complete fragment override and custom fragment depth hooks. |
| [Three compute texture example](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_texture.html), [storage-buffer example](https://threejs.org/examples/webgpu_storage_buffer.html), and [volume example](https://threejs.org/examples/webgpu_volume_perlin.html) | **Demonstrated official examples** | Current TSL/WebGPU storage and raymarching building blocks. |
| [WebGPU specification](https://gpuweb.github.io/gpuweb/) | **Established standard** | API limits, buffers, storage resources, render, and compute behavior. |
| [WGSL specification](https://www.w3.org/TR/WGSL/) | **Established standard** | Concrete scalar types, flow rules, alignment, and recursion prohibition. |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) and its [WebGPU API](https://github.com/gkjohnson/three-mesh-bvh/blob/master/WEBGPU_API.md) | **Demonstrated library** | CPU closest-point/BVH utilities and an evolving TSL/WebGPU BVH API. Pin and qualify before depending on it. |
| [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) | **Established standard** | Hierarchy, animation, material, texture, and color-space semantics. |
| [glTF extension registry](https://github.com/KhronosGroup/glTF/blob/main/extensions/README.md) | **Established registry, checked 2026-08-30** | No ratified general geometry-displacement material property was found as of the review date; project recipes must carry height semantics. |
| [glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) and [Asset Generator](https://github.com/KhronosGroup/glTF-Asset-Generator) | **Established official fixtures** | Standards-focused import, material, skinning, morph, and transform tests. |

## Conversion references

- [OpenVDB MeshToVolume](https://github.com/AcademySoftwareFoundation/openvdb/blob/master/openvdb/openvdb/tools/MeshToVolume.h) — **Established official source** distinguishing signed closed-surface conversion from unsigned open-surface conversion.
- [Robust Inside-Outside Segmentation using Generalized Winding Numbers](https://users.cs.utah.edu/~ladislav/jacobson13robust/jacobson13robust.html) — **Established research** for robust sign classification on imperfect geometry.
- Three [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), [OBJLoader](https://threejs.org/docs/pages/OBJLoader.html), [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html), [SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html), and [MeshSurfaceSampler](https://threejs.org/docs/pages/MeshSurfaceSampler.html) — **Established official API documentation**. SurfaceSampler is diagnostic only for canonical voxel occupancy.

## Licensing cautions

- Papers and blog posts are technical evidence, not implementation licenses.
- Schroeder’s implementation is unpublished.
- The Godot heightmap shader text is CC0 according to its hosting page.
- webgpu-voxel-raymarching is MIT licensed.
- roxlap is dual MIT/Apache-2.0 and describes itself as a clean-room implementation.
- Voxel DSS grants MIT only to the specifically identified core voxel files; its application and whitepaper are not broadly covered.
- Verify the exact revision and license file before copying any source.

Adoption decisions should cite this page and record project-specific runtime evidence in the [cross-project matrix](cross-project-adoption.md).
