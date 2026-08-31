# Foundations and terminology

[Index](README.md) · [Architecture](architecture-options.md) · [Conversion](conversion-pipeline.md) · [Sources](sources.md)

## The key distinction

“Voxel displacement” can refer to several materially different techniques. In this wiki:

- **Voxel-displacement-inspired** means an independent renderer or asset pipeline informed by Daniel Schroeder’s published goals and high-level disclosures.
- **Displaced surface** means a base surface plus a scalar or volumetric field that changes the rendered hit location.
- **Voxelized object** means a triangle mesh sampled into a regular 3D occupancy grid. It does not require a displacement map.

Schroeder’s environment renderer is a displaced-surface system related to shell mapping. His later prop and character path is conventional surface voxelization. Treating both as the same conversion algorithm causes predictable failures around thin parts, animation, topology, and memory.

## Terms

### Voxel and occupancy

A voxel is one cell of a three-dimensional grid. Occupancy records whether that cell participates in the represented object. Occupancy alone does not define good shading; useful assets also need attributes such as albedo or palette index, material style, a shading normal, emissive state, and optional ambient-occlusion data.

### Surface versus solid voxelization

- **Surface voxelization** marks cells intersected by the source surface. Interiors remain empty. It is memory-efficient and matches Schroeder’s object baker.
- **Solid voxelization** also classifies or fills the interior. It is appropriate for cutting, destruction, some collision queries, and volume effects, but costs more memory and requires a robust inside/outside definition.
- **Conservative voxelization** marks every cell touched by a triangle. It avoids random-sampling holes and is the preferred correctness baseline for thin features.

### Heightfield displacement

A heightfield stores one scalar height per texture coordinate. It can represent overhang-free surface relief. Quantizing height to voxel-sized steps creates block geometry; retaining the continuous gradient for normals preserves sub-voxel lighting detail.

Heightfield methods are practical on planes, terrain, and well-controlled UV patches. They do not by themselves solve hard corners, overlapping UV shells, high curvature, or arbitrary non-heightfield detail.

### Shell mapping

Shell mapping constructs a volumetric parameterization between a base surface and an offset surface. That volume can carry geometric detail and affect silhouettes without globally tessellating the base mesh.

The mapping must remain usable and non-self-intersecting. High curvature, sharp corners, thin walls, and bad topology make this difficult. Schroeder states that his technique is related to shell mapping but does not disclose the mapping or preprocessing machinery.

### Shading normal versus cube-face normal

The visible voxel geometry has axis-aligned face normals. A separately stored shading normal can make lighting imply the source model’s smooth or fine-scale form while the silhouette remains blocky.

For source-driven baking, interpolate the detailed triangle mesh normal at the selected surface point. For occupancy-only assets, a derived normal from a density gradient or nearby occupancy centroid is a useful fallback. Thin one-voxel features may need a normal cone or range rather than a single vector; Schroeder publicly describes integrating light over a one-dimensional normal range for this case.

### DDA

A digital differential analyzer steps a ray from one grid boundary to the next. Amanatides–Woo DDA is the standard uniform-grid baseline. Hierarchical DDA applies the same idea across coarse cells or tree nodes so a ray skips large empty regions.

### Brick map

A brick map divides a volume into small dense grids, commonly 4³ or 8³ cells, and stores only non-empty bricks behind a directory. It is easy to construct, stream, update, and implement in shaders. A top-level grid plus 8³ bricks is the **speculative project choice** for the first renderer, not a disclosed part of Schroeder’s environment technique.

### SVO and sparse 64-tree

A sparse voxel octree recursively divides space into 2×2×2 children. It compresses empty or homogeneous regions and accelerates empty-space traversal.

A sparse 64-tree uses 4×4×4 children. A node’s occupancy fits in 64 bits, the tree is shallower, and child data can be compacted by population count. WGSL has no concrete 64-bit integer. Using two 32-bit masks and split population counts is this project’s proposed browser encoding.

### SVDAG

A sparse voxel directed acyclic graph deduplicates identical subtrees of an SVO. It can compress immutable, repetitive scenes dramatically, but complicates editing, construction, animation frames, and per-voxel attributes. It is an optimization candidate, not an MVP requirement.

### Proxy-box ray traversal

Instead of drawing every visible cube, render the object or chunk bounding box. For each covered fragment, transform the view ray into object-local space, traverse occupancy, shade the first hit, and write its true depth. Schroeder publicly identifies this as the object-rendering shape of his current renderer.

### Level of detail

A spatial hierarchy is not automatically a correct visual LOD. A coarser node needs representative coverage, color, normal, and material information. Without filtered attributes, thin features disappear and distant surfaces shimmer.

### Temporal DAG and baked frames

A baked voxel animation stores independently voxelized poses. A temporal DAG shares identical spatial subtrees across frames. The latter can reduce storage after a correct frame-baked implementation exists, but it adds encoding and runtime complexity.

## What remains authoritative

The voxel asset is a render representation unless a project explicitly promotes it to gameplay authority. For img2threejs:

- the original component tree remains semantic and interaction authority;
- source mesh or authored collider remains collision and navigation authority;
- original rig, clips, morph targets, and sample times remain rebake provenance;
- the voxel bundle records conversion results, warnings, and render attributes;
- an exact displaced hit query is optional and must not silently replace broader gameplay collision.

This separation preserves action-ready models while allowing the renderer to become radically different.

## Failure modes to reject

An automatic converter should reject or route around:

- non-manifold or inconsistently oriented meshes when a signed displacement field is requested;
- inward displacement that can cross the opposite side of a thin feature;
- ambiguous nearest-surface orientation on open or intersecting meshes;
- missing or degenerate UVs for UV-driven displacement;
- alpha blending, transmission, or volume materials when no approximation policy was selected;
- unbounded animation frame counts;
- dense allocations that exceed a preflight memory budget;
- claims of parity based only on a build or one screenshot.

The detailed routing and validation rules are in [conversion pipeline](conversion-pipeline.md). Data-structure tradeoffs are in [architecture options](architecture-options.md), and evidence is catalogued in [sources](sources.md).
