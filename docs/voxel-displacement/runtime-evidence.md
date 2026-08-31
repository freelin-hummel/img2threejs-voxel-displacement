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

## 2026-08-30 · ImageGen angle set through the low-poly tree E2E

The prompt-only route now asks the built-in Codex ImageGen tool for one style/identity anchor and
five construction references: front `(azimuth 0°, elevation 0°)`, right `(90°, 0°)`, back `(180°,
0°)`, left `(270°, 0°)`, and top-down `(0°, 90°)`. The exact contract and checked-in images are in
[`dark-fantasy-tree-reference-set.json`](../../integrations/voxel_displacement/reference/fixtures/dark-fantasy-tree-reference-set.json).
The anchor is not treated as sufficient hidden geometry; all locked fields must remain consistent
while only the camera angle changes. ImageGen output is a reconstruction hypothesis and still
requires identity review before it is considered measurement-grade reference data.
The current gpt-image-2 outputs are opaque RGB PNGs (the top view also has a different canvas size),
so the manifest marks this set `reference-only-needs-normalization`; a future silhouette/visual-hull
consumer must normalize canvas, scale, and background first.

The deterministic low-poly fixture in
[`generate_low_poly_tree_obj.py`](../../forge/stage3_build/generate_low_poly_tree_obj.py) was then
voxelized at longest-axis resolution 48:

```bash
python3.11 forge/stage3_build/generate_low_poly_tree_obj.py --out /tmp/dark-fantasy-tree.obj
python3.11 forge/stage3_build/voxelize_obj.py \
  --mesh /tmp/dark-fantasy-tree.obj --longest-axis-voxels 48 \
  --out /tmp/dark-fantasy-tree-bake.json
jq '.vxd' /tmp/dark-fantasy-tree-bake.json > /tmp/dark-fantasy-tree-props.json
sceneproof render integrations/voxel_displacement/reference/scene.js \
  three:voxel-reference-cubes --export createVoxelReferenceScene --renderer three \
  --props /tmp/dark-fantasy-tree-props.json --view isometric --framing fit --zoom 1.2 \
  --out integrations/voxel_displacement/reference/evidence/dark-fantasy-tree-isometric-voxel.png
```

The receipt is `success: true`, `boundsValid: true`, `targetFound: true`, and 1280×720. The source
has 1,184 non-degenerate triangles; the converter emits 5,012 occupied cells across 62 chunks
(`voxelSize: 0.1584315`) with four material slots (bark, leaf, moss, rune). The checked-in
[`dark-fantasy-tree-isometric-voxel.png`](../../integrations/voxel_displacement/reference/evidence/dark-fantasy-tree-isometric-voxel.png)
is the visually inspected proxy result. This proves the ImageGen-reference → low-poly OBJ →
final-cell VXD → Three.js raster proxy path only; it does not prove GLB extraction, WebGPU traversal,
animation, or Schroeder parity.

Open gates: GLB buffer extraction, worker cancellation/progress, alpha-cutout occupancy, per-cell
material shading, scene-depth composition, animation frame baking, binary multi-chunk packaging,
and WebGPU/TSL traversal remain unimplemented.
