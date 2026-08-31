# Animation

[Index](README.md) · [Foundations](foundations.md) · [Conversion](conversion-pipeline.md) · [WebGPU](webgpu-threejs.md)

Animation is where voxel rendering most easily breaks the source model’s action-ready contract. Preserve the original hierarchy and animation provenance even when the visible representation becomes a sequence of baked grids.

## Supported strategies

| Strategy | What moves | Benefits | Limits | Status |
| --- | --- | --- | --- | --- |
| Rigid object transform | One voxel grid’s model matrix | Cheap; exact hierarchy preservation | No deformation | **Established** |
| Rigid component hierarchy | One grid per articulated rigid node | Reuses node animation and object grids | Joint gaps/overlap; many traversals | **Established technique; speculative integration here** |
| Baked pose frames | Complete posed mesh voxelized at selected times | Robust silhouette; intentionally sprite-like | No interpolation or arbitrary blending; memory growth | **Demonstrated by Schroeder** |
| Bind-pose volume plus animated shell | Rays inverse-deformed through an animated shell into a static volume | Avoids rebuilding occupancy | Foldovers and joint behavior are difficult; old prototype evidence | **Demonstrated experimentally** |
| Hierarchy-preserving SVO transforms | Transform subvolumes without rebuilding their trees | Efficient rigid/anisotropic transforms | Not ordinary blended skeletal skinning | **Established research** |
| Temporal DAG | Share identical subtrees across baked frames | Can reduce frame storage | More complex encoder and attribute handling | **Established research; speculative adoption** |
| Live per-frame voxelization | Rebuild occupancy from current pose every frame | Continuous source animation in principle | Conversion/upload cost and temporal instability | **Speculative** |
| Direct smooth voxel-space skinning | Blend voxels or rays with bones | Conventional animation controls in principle | Undefined topology, gaps, overlap, and filtering | **Speculative** |

## Recommended first path

### Rigid hierarchy

For machinery, weapons, modular structures, and other rigid assemblies:

1. voxelize each rigid mesh once in its own local grid;
2. retain the original node pivot, parent, transform channel, sockets, and collider;
3. update only the object table’s transform each frame;
4. traverse each grid in object-local space;
5. validate joints at the extremes of every motion range.

This keeps img2threejs’s semantic component tree useful. Do not merge all parts into one baked volume if doing so removes interaction or attachment authority.

### Skinned and morphed characters

For non-rigid deformation, the sequence below is a **speculative project policy** built around Schroeder’s demonstrated frame-bake approach. The proposed 8–12 FPS range, shared grid, root-motion extraction, deduplication order, and runtime controller are not disclosures of his implementation.

1. choose clips and a fixed sample rate; this project proposes 8–12 frames per second as a starting aesthetic setting;
2. compute the union of selected posed bounds;
3. define one rest-anchored object-local voxel grid for every clip;
4. evaluate the original Three.js animation at an exact sample time;
5. materialize posed geometry, including morph targets and skinning;
6. surface-voxelize that pose with the same grid and attribute rules;
7. record root motion separately;
8. deduplicate identical frames only after the uncompressed sequence validates;
9. play the nearest baked frame without interpolation.

This is intentionally analogous to sprite animation. Schroeder’s implementation uses this approach and accepts the inability to blend animations dynamically.

## Source authority and runtime contract

Retain:

- source scene hierarchy and stable node identifiers;
- skeleton, bind matrices, bone order, and inverse bind matrices;
- original animation clips and selected sample times;
- morph target names and weights;
- animation events and their original times;
- sockets and bone attachments;
- hitbox, collider, and gameplay-query authority;
- root-motion policy;
- material-animation and procedural-animation policy, including anything rejected rather than baked;
- material state relevant to each sample;
- source and converter hashes.

The visible voxel sequence does not become the authoring source. A new clip, changed pose, retarget, or corrected weight should trigger a deterministic rebake from the original asset.

A proposed runtime controller should expose at least:

    update(delta)
    play(clip, options)
    stop()
    seek(time)
    replay()
    finish()
    dispose()

It should also expose the source semantic hierarchy and the active voxel frame separately. “Animated” must not mean only that a frame index increments; acceptance needs visible, source-consistent deformation.

## Frame grid and timing rules

- Use one grid origin, dimensions, and voxel size across the selected animation set.
- Never recenter each frame independently.
- Store sample time explicitly rather than inferring it from array position.
- Define loop endpoint behavior so the first frame is not duplicated accidentally.
- Preserve root translation separately when in-place animation is desired.
- State whether sampling occurs before or after root-motion extraction.
- Use nearest-frame playback for the first aesthetic target.
- Treat cross-fading as clip-selection logic until a voxel interpolation method is separately qualified.

## Shading animated voxels

At each occupied cell, prefer normals interpolated from the posed detailed source mesh. Keep these independent of cube-face geometry.

Potential later enhancements:

- occupancy-derived AO baked per frame;
- a normal range or cone for one-cell-wide limbs, branches, straps, and hair;
- frame-coherent palette assignment to reduce color flicker;
- temporal filtering of source attribution, provided it does not blur intended stepped motion.

Do not reuse bind-pose normals after deformation unless a verified transform maps them to the posed surface.

## Memory

Surface-only frames avoid interior voxels but still scale with:

    occupied surface voxels × bytes per occupied voxel × frames
    + brick directories and masks
    + clip/frame metadata

Schroeder reports 4.6 MB for one 14-frame zombie walk in his current encoding and estimates roughly 1.3 GB for 200 frames across 20 similarly sized enemy types. These are author-reported planning numbers, not portable budgets.

Apply optimizations in this order:

1. measure required voxel resolution and sample rate;
2. bake only clips and frames that ship;
3. remove byte-identical frames;
4. share palettes and material tables;
5. deduplicate identical bricks across adjacent frames;
6. stream clips or enemy types;
7. evaluate temporal DAG compression.

Avoid designing a temporal codec before representative uncompressed sequences establish where memory is actually spent.

## Acceptance

Every animated asset needs:

- source clip, duration, sample rate, sample times, and loop policy;
- stable grid origin, dimensions, scale, and pivot;
- byte-identical rebake on identical inputs;
- per-frame occupancy and attribute hashes;
- ground-contact and facing-direction checks;
- silhouette views at rest, contact, extension, compression, and twist poses;
- evidence that thin features do not blink unintentionally;
- expected motion in more than one body region;
- measured frame variation, memory, upload behavior, and runtime frame time;
- explicit results for unsupported IK, additive clips, cross-fades, material animation, and procedural modifiers.

The source rig can pass payload validation while the baked motion is still visually wrong. Runtime browser evidence is required. See [sources](sources.md) for the evidence behind each strategy.

## Research paths after the MVP

- [Efficient Animation of Sparse Voxel Octrees](https://arxiv.org/abs/1911.06001) for hierarchy-preserving transforms.
- [VoxelRenderer](https://github.com/nieznanysprawiciel/VoxelRenderer) for the bind-pose SVO plus animated-shell inverse-ray experiment.
- [Exploiting Coherence in Time-Varying Voxel Data](https://www.cse.chalmers.se/~uffe/exploiting_coherence_in_time-varying_voxel_data.pdf) for temporal DAG compression.
- [roxlap](https://github.com/NCrashed/roxlap) as a current WGPU/WGSL implementation reference for voxel clips and articulated voxel formats.

Implementation and codec stages are detailed in [conversion pipeline](conversion-pipeline.md). Cross-project capability claims belong in the [adoption matrix](cross-project-adoption.md).
