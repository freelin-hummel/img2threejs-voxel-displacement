# Voxel displacement reference renderer

`scene.js` is a source-owned Three.js reference renderer for the VXD v1 logical document. It places
one `BoxGeometry` instance at each final occupied cell and transfers the baked albedo and normal
attributes. This is intentionally a proxy renderer, not the production traversal milestone: it does
not perform WebGPU traversal, hierarchical DDA, texture sampling, or a second displacement pass.

## SceneProof evidence

From this directory's package root:

```bash
sceneproof inspect reference/scene.js \
  --export createVoxelReferenceScene --renderer three
sceneproof render reference/scene.js THREE_NODE_ID \
  --export createVoxelReferenceScene --renderer three \
  --view isometric --framing fit --out /tmp/voxel-reference.png
```

Use the `three:voxel-reference-cubes` node id emitted by `inspect`. Inspect the PNG itself before
using it as acceptance evidence; the command succeeding only proves that the source loaded.

The checked-in `reference/fixtures/mini.vxd.json` can be supplied directly with `--props` to prove
that the renderer consumes a final-cell VXD document rather than only its built-in demo:

```bash
sceneproof inspect reference/scene.js --export createVoxelReferenceScene --renderer three \
  --props reference/fixtures/mini.vxd.json
```

## Manual browser page

Serve the repository root, then open the page (optionally with a generated artifact):

```bash
python3 -m http.server 8000 --directory ../..
open 'http://127.0.0.1:8000/integrations/voxel_displacement/reference/index.html'
open 'http://127.0.0.1:8000/integrations/voxel_displacement/reference/index.html?asset=/path/to/voxel-object-bake.json'
```

The page uses an import map for Three.js and exposes
`window.__IMG2THREEJS_VOXEL_REFERENCE_READY__` after the renderer has created a WebGL frame.
