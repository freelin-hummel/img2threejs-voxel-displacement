# Cross-project adoption

[Index](README.md) · [Architecture](architecture-options.md) · [Conversion](conversion-pipeline.md) · [Animation](animation.md) · [WebGPU](webgpu-threejs.md) · [Sources](sources.md)

Adopt the capability as a versioned asset and runtime contract, not by copying a shader and assuming the source project’s topology, units, animation, or browser conditions.

## Adoption levels

| Level | Capability | Required evidence |
| --- | --- | --- |
| 0 — research | Sources and architecture choice only | Project-specific decision record and explicit unknowns |
| 1 — texture bake | Height steps, continuous field, provisional normals, optional albedo | Deterministic fixture output and documented texture semantics |
| 2 — static voxel asset | Conservative surface occupancy and attributes | Geometry/material gates and codec round trip |
| 3 — reference rendering | Instanced or greedy-mesh fallback | Multi-view browser evidence |
| 4 — WebGPU traversal | Proxy traversal and true scene depth | CPU/GPU hit oracle, composition tests, named target performance |
| 5 — rigid animation | Voxel grids retain node transforms and attachments | Extreme-pose joint and interaction evidence |
| 6 — baked deformation | Skinned/morphed clips as fixed frames | Motion, ground contact, memory, timing, and jitter evidence |
| 7 — scale features | LOD, compression, paging, or streaming | Representative scene residency and frame-time evidence |

No project should advertise a higher level because an upstream branch has code for it. Each consumer must qualify the exact exported asset, runtime revision, host scene, browser/GPU, and fallback.

Promotion also requires the exact repository head, artifact hash, adapter/runtime revision, evidence date, and evidence location. Runtime evidence from another consumer does not promote img2threejs or any third project automatically.

## Portable boundaries

### Converter

Inputs source assets and explicit semantics; outputs a versioned bundle plus report. It owns topology analysis, voxelization, material sampling, frame baking, deterministic packing, and conversion warnings.

### Asset bundle

Contains object-local grid data, attributes, palettes, animation metadata, source hashes, recipe, converter version, and compatibility requirements. It contains no host-specific scene pointers.

### Runtime adapter

Maps the portable bundle into a host renderer and object hierarchy. It owns buffer paging, backend selection, proxy meshes, traversal material, frame selection, disposal, and diagnostics.

### Host integration

Keeps gameplay authority: semantic nodes, sockets, collision, hitboxes, navigation, events, camera, lighting, and lifecycle. It decides which queries need exact visible displacement.

Maintaining these boundaries allows a project to replace brick maps with an SVO or replace the renderer while preserving the asset and gameplay contract.

## Intake checklist

Before adding a consumer project, answer:

- Which asset classes are in scope: materials, environment surfaces, props, rigid assemblies, or characters?
- Is the source procedural Three.js, GLB, OBJ, textures, or another canonical format?
- What owns transforms, units, pivots, sockets, colliders, hitboxes, and events?
- Are meshes closed, open but oriented, non-manifold, thin, skinned, morphed, or dynamically generated?
- Which material features must survive?
- Which platforms, browsers, GPUs, and resolutions are supported?
- Is WebGPU mandatory, optional, or unavailable?
- What is the explicit fallback?
- What are conversion-time, package-size, resident-memory, and frame-time budgets?
- What visual and runtime evidence blocks adoption?
- Who owns rebakes when a source, converter, or schema changes?

## Current artifact caution

The repository’s current texture bake is Level 1, while a static OBJ converted with
`stage3_build/voxelize_obj.py` is Level 2 and the source-owned Three.js proxy is Level 3 only when
the recorded browser evidence is carried with the asset. Consumers must not reinterpret either
artifact as proof of:

- linear-light or physically calibrated height;
- world-scale or tangent-basis-correct normals;
- GLB or arbitrary mesh shell displacement beyond the bounded static-OBJ converter;
- conservative object voxelization;
- animated voxel frames;
- WebGPU rendering;
- browser acceptance.

Until corrected, the existing height field is a deterministic weighted-encoded-RGB heuristic and the normal field is a clamped texture-space finite-difference result. Pin decoder, converter, codec, and runtime versions when comparing deterministic output. Absolute source paths and platform decoder fallbacks can also make whole-artifact bytes differ even when decoded channels match.

## Adoption matrix template

Copy this table into the consumer project’s decision record:

| Field | Consumer entry |
| --- | --- |
| Project / repository | |
| Owner | |
| Decision date | |
| Requested adoption level | |
| Source authority and format | |
| Source units / axes / handedness | |
| In-scope asset classes | |
| Conversion modes | |
| Topology assumptions | |
| Height channel / transfer / zero / amplitude / units | |
| UV set / wrap / origin / normal-Y convention | |
| Voxel size or longest-axis resolution | |
| Chunk / structure choice | |
| Required shading attributes | |
| Animation policy and sample rate | |
| Root motion / events / attachments | |
| Collider / hitbox / navigation authority | |
| Target Three and runtime revision | |
| Target browser / OS / GPU | |
| WebGPU capability requirements | |
| Explicit fallback | |
| Conversion-time budget | |
| Package / resident-memory budget | |
| Frame-time / resolution budget | |
| Visual acceptance fixtures | |
| Runtime/depth acceptance fixtures | |
| Performance evidence location | |
| Unsupported features | |
| Rollback / disable switch | |
| Rebuild owner and trigger | |
| Status: proposed / prototyped / qualified / rejected | |
| Open blockers | |

## Capability matrix template

Use one row per representative asset rather than declaring support from a toy fixture:

| Asset | Route | Topology | Materials | Motion | Backend | Fallback | Conversion | Memory | Visual gate | Depth/runtime gate | Result |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| Example static prop | surface-shell | closed / thin | opaque PBR | rigid | webgpu proxy | greedy mesh | TBD | TBD | pending | pending | proposed |
| Example environment patch | heightfield | controlled UV patch | albedo + declared height | static | webgpu proxy | source mesh | TBD | TBD | pending | pending | proposed |
| Example character clip | baked-frames | posed skinned surface | opaque PBR | fixed frames | webgpu proxy | source skinned mesh | TBD | TBD | pending | pending | proposed |

## Evidence package

Every qualified adoption should retain:

- source and dependency hashes;
- conversion command/options and complete report;
- decoded channel or bundle hashes;
- pinned converter, Three, browser, OS, and GPU information;
- selected adapter limits and backend reason;
- canonical screenshots and diagnostic passes;
- CPU/GPU ray-hit comparisons;
- performance capture at fixed resolution;
- fallback capture;
- unsupported-feature findings;
- rollback or feature-flag instructions.

## Versioning and compatibility

- Increment the schema when decoding meaning changes, not only when fields are added.
- Keep a migration or fail with an actionable version error.
- Treat height transfer function, edge mode, normal convention, quantization, and grid transform as semantic version inputs.
- Reject malformed offsets, impossible counts, out-of-bounds pages, excessive loop limits, and unsupported attributes before GPU upload.
- Never silently reinterpret an older provisional normal or height field as a newer calibrated field.
- Use decoded semantic channel hashes when platform-specific paths or packaging metadata would otherwise defeat reproducibility comparisons.

## Cross-project rollout

1. Select one representative static asset and its acceptance views.
2. Import the portable bundle without changing gameplay or collision authority.
3. qualify the reference fallback.
4. qualify WebGPU traversal and depth on the target runtime.
5. test the forced fallback on the same asset.
6. add one difficult thin/material-seam asset.
7. only then add rigid or baked animation.
8. update the matrix with measurements and unsupported cases.
9. promote the adoption level only when all required evidence is stored.

The evidence basis for every capability is catalogued in [sources](sources.md). Proposed implementation details are in [architecture options](architecture-options.md).
