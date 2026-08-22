# GLB-reference character prompt

A copy-paste prompt for rebuilding a character from a **GLB reference** as procedural Three.js code,
for img2threejs 1.5.1 and later. It works for any character.

This is the GLB-mediated route: the GLB is a *measurement instrument*, and the deliverable is
TypeScript that reproduces the measured surface with no `.glb` or `.bin` fetched at runtime. For the
ordinary single-image route, the prompt in the README's "Driving it harder" section is the right
starting point instead.

Every rule below exists because skipping it produced a wrong result that passed the gates in place at
the time. The measured figures are kept in the prompt on purpose — an agent that reads
"silhouette IoU is not enough" will skip the step; one that reads "a model with its face deleted
scored 0.8803, identical to the finished face" will not.

## How to use it

1. Replace every `<PLACEHOLDER>`.
2. Paste the whole thing as one prompt. It is written to complete in a single pass.
3. If the agent reports a hard stop, that is the prompt working. Answer the question it asks rather
   than telling it to continue.

## The prompt

````text
Build a procedural Three.js character from a GLB reference using img2threejs 1.5.1.

## Inputs
- GLB reference:  <ABSOLUTE_PATH_TO_GLB>
- Reference photo (optional): <PATH_OR_NONE>
- Subject name:   <SubjectName>
- Demo id:        <subject-id>
- Showcase root:  <PATH_TO_img2threejs-showcase>
- Real longest dimension: <e.g. 1.70 m>   # for sanity-checking scale, not for scaling

## Hard contract — do not violate these

1. **The GLB is a measurement instrument, never an asset.** Symlink it into
   `public/mesh/` (gitignored). Nothing about its topology, materials or textures may
   be copied into the factory. No `.glb`/`.bin` may be fetched by the running demo.
2. **Verify magic bytes, never HTTP status.** A dev server returns `index.html` with
   HTTP 200 for a missing file. Check the file starts with `glTF` before trusting it.
3. **Never label a node from its name.** Run
   `python3 forge/stage1_intake/label_glb_nodes.py <glb> --out nodes.json --min-confidence 0.6`.
   Baseline assets name nodes `root.0..root.N`; any name-reading labeller produces
   confident nonsense. Labels come from measured world-space bounds. Treat every label
   as `hypothesis-requires-render-confirmation` until a render confirms it.
4. **Measure before every numeric decision.** Any spoke count, cell size, threshold or
   tier you cannot point at a printed measurement for is a guess — say so explicitly
   rather than presenting it as derived.
5. **State gate on every step.** `python3 forge/next.py --state .img2threejs/state.json`
   at start, at resume, and before every correction. Exit 3 / `status=stopped` is a hard
   stop: report and ask, never continue from memory.
6. **Never claim "done" when it is "improved."** Name what still does not match.

## Procedure

### Stage 0 — Intake
```
python3 forge/state.py init --state .img2threejs/state.json --reference <glb> --profile character --spec object-sculpt-spec.json
python3 forge/stage1_intake/probe_glb.py <glb> --out glb-probe.json
python3 forge/stage1_intake/label_glb_nodes.py <glb> --out nodes.json --min-confidence 0.6
```
Record per node: vertex/triangle count, whether `NORMAL` exists (required for oriented
reconstruction), and whether the primitive is single-material/single-component. If
`semanticDecomposition` reports a merged one-node/one-mesh asset, it is **insufficient**
for per-region claims — say so and request a multipart GLB rather than inventing regions.

### Stage 1 — Cross-section loft (the code-only floor)
This must always work with **zero external data** — it is the fallback that proves the
pipeline is not secretly shipping the source mesh.

Measure the spoke budget per node, do not pick it:
```
python3 integrations/glb_character_pipeline/python/measure_density_convergence.py <glb> <node>
```
It prints two tables and then the line that matters:
`density ceiling (largest median <= 5%)`. Take **`min(convergence, density ceiling)`** per node:
- *convergence* = first spoke count where the radial outline stops changing.
- *density ceiling* = largest count keeping median empty angular bins <= 5%. Convergence is only
  measured up to it, because using an unsupported reference asks interpolated, vertex-free arcs to
  define truth. If the tool reports `none`, no spoke count is supported — say so rather than picking
  the floor.

Taking convergence alone is wrong and the failure is silent: `radial_outline`
interpolates an empty angular bin from its neighbours, so past a node's density the
outline bridges arcs holding no vertices and **bulges outward**. Measured on a real
subject: 192 spokes grew a glove to 1.12x the baseline's area while its IoU *fell*
0.896 -> 0.867, and pushed a pouch 7.96 mm past its own point cloud. Slice count stays
at 40 — error against a 320-slice reference is U-shaped (13.81% at 20, 8.59% at 40,
13.83% at 160), because a thinner band holds fewer points and its percentile turns to
sampling noise.

Then emit, writing region and spoke maps to JSON rather than hardcoding:
```
CHARACTER_SECTION_REGIONS_JSON=... CHARACTER_SPOKES_JSON=... CHARACTER_CROSS_SECTIONS=... \
python3 integrations/glb_character_pipeline/python/build_cross_sections.py
```

### Stage 2 — Implicit surface, only where the loft cannot reach
A cross-section is 2.5D — one radius per angular bin — so no spoke count recovers a fold
that doubles back on itself (an eyelid, a nostril). **Measure per-node noise first and
only promote the nodes that need it**; on a full character roughly half the regions never
did. Stage 2 is expensive.

Cell size is **per node, not global**, and comes from the finest real feature: a lid
margin is ~1 mm, so a head needs ~1.5 mm; a large smooth surface carries nothing that
fine and doubles the file for no measured gain below ~2.5 mm.

Pass them as a `{node: metres}` map, and **do not round a measured cell size**. Stage 3 recovers
the grid origin from the cell, so rounding a measured 1.504 mm to 1.50 mm shifts the recovered grid
— that produced 110,695 apparent cell collisions on one node even though Surface Nets emits exactly
one vertex per active cell by construction.
```
CHARACTER_GLB=... CHARACTER_DIFFUSE=<diffuse.png> CHARACTER_CELL_SIZES_JSON=<cells.json> \
python3 integrations/glb_character_pipeline/python/export_sdf_surfaces.py <node...>
```
If the reference's materials may be measured but not copied, run geometry-only: vertex colour stays
white so the independently authored Three.js material is left un-tinted.
Colour is baked from the diffuse image, **sRGB decoded to linear** — Three.js treats a
vertex-colour attribute as already being in the working space. The `HEDS` binary this
writes is a dev-only intermediate and is **not** the deliverable.

### Stage 3 — Encode to TypeScript, verify before writing a byte
Surface Nets places exactly one vertex per sign-changing cell, so the index buffer is
derivable from cell adjacency and normals are recomputable. **Prove that on the real data
first, on every node:**
```
node integrations/glb_character_pipeline/node/verify_cells.mjs <bin> <glb>
```
It must report **0 collisions and every quad rebuilt** before you run the encoder.
`build-character.sh` now runs this itself before every encode, so prefer the orchestrator over
calling the three Stage 3 scripts by hand.
Recover the grid origin from the builder's own rule (`lo = cloud_min - 5*cell`), never by
sweeping for a sub-cell phase — a search-based origin put 29% of vertices in an
already-occupied cell.

Then encode, emit, and round-trip each level against the binary it replaces:
```
node integrations/glb_character_pipeline/node/encode_surfaces.mjs <level>
node integrations/glb_character_pipeline/node/emit_surface_module.mjs <level> <dest.ts>
node integrations/glb_character_pipeline/node/verify_roundtrip.mjs <level>
```
**Run `git diff` on every file you just wrote.** A swapped level->filename mapping writes
valid, wrong data with no error anywhere: tsc, the round-trip check and the build all
pass, because the module is still valid TypeScript carrying a valid but mislabelled level.
Only `git diff` catches it.

### Stage 4-6 — Rig, then features
```
python3 forge/stage5_rig/validate_rig_payload.py <spec>       # before binding any Skeleton
```
Left/right is a **reflection**, never a rotation: negate the lateral axis only. Two
different defects need two different gates — `validate_chirality` catches a rotation
mistaken for a reflection, and `medial_lateral_bias` against a reference catches a pair
wrong the *same* way on both sides (which any mirror test passes by construction).
Reflecting inverts triangle winding; flip it back or `flatShading` lights the limb as
though lit from behind.

If the subject has hair: `scalp_exposure.py` is a **hard** gate on geometry before any
render. A bald patch is always a failure; a coverage shortfall is a soft signal and never
on its own authorises widening the masses.

For a facial feature placed as a thin card (eye, lash), fit it as a clean analytic form
seated into its socket. Do not chase zero error on the socket rim — make the residual
**one-sided** (always proud, never sunk) instead. Chasing zero cost three rebuilds; two
constants making the error one-sided fixed the actual complaint.

### Stage 7 — Gates. A single viewpoint is not evidence.
```
python3 forge/stage4_review/turntable_gate.py --capture 0=front.png --capture 90=right.png --capture 180=rear.png --capture 270=left.png --json
node runtime/scripts/export_mesh_geometry.mjs --url <preview> --out meshes.json
python3 forge/stage4_review/self_intersection.py meshes.json --json
python3 forge/stage4_review/attachment_anchor.py <spec> --measured measured.json --json
python3 forge/stage4_review/interior_difference.py <baseline.png> <render.png> --json
python3 forge/stage4_review/diagnose_render_multi_angle.py ...
```
- **Measure inside the silhouette.** Silhouette IoU reads ~11% of figure cells: a model
  with its face deleted scored 0.8803, identical to four decimals to the finished face.
- Read `sampledVertexCount` / `unmeasuredAttachments` / `missingAzimuths` before believing
  a clean verdict — each names the part of the model the gate did not look at.
- A hole through a skull, a hat at hip height and a floating charm all survived eight
  front-only review rounds before these gates existed.

### Stage 8 — Prove nothing is fetched, then look at it
Move the binary directory out of the way, rebuild, and re-render. Renders that still
appear with that directory absent **are** the proof.
```
npx tsc --noEmit && npx vite build
```
**Then actually look at the render, at 0, 40 and a grazing angle.** Metrics hide
structural failure: a surface can score 2.49 mm median accuracy and still read as a
lumpy, hole-riddled shell rather than a face. If the render and the metric disagree,
the render is right.

## Report format
For each stage: what was **measured** (the number and the command that printed it), what
was **decided** from it, and what remains **unverified**. Close with:
- per-region confidence, and which regions the views never covered;
- every number you could not measure, named as an assumption;
- what still does not match the reference.

"This cannot reach the requested fidelity from this reference" is a valid result. Say it
rather than producing a confident wrong surface.
````

## Requirements

- **img2threejs 1.5.1+**, and a companion `img2threejs-showcase` checkout reachable through
  `IMG2THREEJS_SHOWCASE_ROOT`.
- The Stage 1–3 commands live in `integrations/glb_character_pipeline/`, an opt-in integration with
  its own `pyproject.toml`/`uv.lock` (numpy + Pillow) so the stdlib-only `forge` core stays
  dependency-free:

  ```bash
  uv sync --project integrations/glb_character_pipeline --python 3.11
  cd integrations/glb_character_pipeline/node && npm install
  ```

- A **multipart** GLB. A merged single-node asset cannot support per-region claims, and the prompt
  instructs the agent to say so rather than invent regions.

## Where each rule comes from

| Rule in the prompt | What it prevents |
|---|---|
| Label nodes from measured bounds | Baseline assets name nodes `root.0..root.N`; a name-reading labeller is confidently wrong |
| `min(convergence, density)` | Convergence alone bulged a glove to 1.12x its area while IoU *fell* 0.896 → 0.867 |
| Per-node cell size | A 1 mm lid margin needs ~1.5 mm cells; a large smooth surface doubles the file below ~2.5 mm for no measured gain |
| `verify_cells.mjs` before encoding | A swept grid origin put 29% of vertices in an already-occupied cell |
| Never round a measured cell size | Rounding 1.504 mm to 1.50 mm shifted the recovered grid and produced 110,695 apparent collisions on one node |
| `git diff` after every emit | A swapped level→filename mapping passes tsc, round-trip *and* build while shipping wrong data |
| Measure inside the silhouette | A face-deleted model scored 0.8803 — identical to the finished face |
| Look at the render last | A 2.49 mm-accurate surface still read as a lumpy shell, not a face |

## Related

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — script-by-script reference and expected artifacts.
- [`integrations/glb_character_pipeline/PIPELINE.md`](../integrations/glb_character_pipeline/PIPELINE.md) —
  the full per-stage method this prompt drives, including the anti-pattern catalogue.
- [`docs/HAIR_PIPELINE.md`](HAIR_PIPELINE.md) — the hair contract, if the subject has hair.
