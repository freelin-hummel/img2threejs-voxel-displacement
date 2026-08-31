# Runtime evidence

This receipt records the first browser check of the static OBJ-to-VXD slice. It is intentionally
separate from the production release gate: the proxy proves source loading, final-cell placement,
and ordinary Three.js rasterization, but not WebGPU traversal, true hit depth, or parity with
Schroeder's unpublished renderer.

## 2026-08-30 · static OBJ output through the Three.js proxy

Source fixture: a UV-mapped two-triangle OBJ plane, a 4×4 opaque height map with a stepped region,
and a 4×4 opaque albedo map. The forge converter emitted 357 occupied cells in 9 VXD chunks at
`voxelSize: 0.0625`. The props fixture passed to SceneProof was the emitted artifact's `vxd` member
(`sha256:bfed8a568e080e2c42fa601b4ca8db64de467969579a6d8932f39e49e581f5bd`).

Environment preflight:

```text
sceneproof doctor
browserLaunched=true chromiumFound=true webglAvailable=true
renderer=ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE))
```

Source inspection and render:

```bash
sceneproof inspect integrations/voxel_displacement/reference/scene.js \
  --export createVoxelReferenceScene --renderer three \
  --props /tmp/voxel-evidence-*/props.json
sceneproof render integrations/voxel_displacement/reference/scene.js \
  three:voxel-reference-cubes --export createVoxelReferenceScene --renderer three \
  --props /tmp/voxel-evidence-*/props.json --view isometric --framing fit \
  --out /tmp/voxel-object-bake-reference.png
```

SceneProof reported `success: true`, `boundsValid: true`, `moduleLoaded: true`,
`exportFound: true`, `targetFound: true`, and a 1280×720 output. The PNG was visually inspected:
the plane is represented by a contiguous voxel-cell surface and the height step is visible as a
raised edge. This is a source-grounded proxy check, not a silhouette/depth acceptance result.

The checked-in miniature document can be replayed without generating temporary source inputs:

```bash
sceneproof inspect integrations/voxel_displacement/reference/scene.js \
  --export createVoxelReferenceScene --renderer three \
  --props integrations/voxel_displacement/reference/fixtures/mini.vxd.json
```

Open gates: GLB buffer extraction, worker cancellation/progress, alpha-cutout occupancy, per-cell
material shading, scene-depth composition, animation frame baking, binary multi-chunk packaging,
and WebGPU/TSL traversal remain unimplemented.
