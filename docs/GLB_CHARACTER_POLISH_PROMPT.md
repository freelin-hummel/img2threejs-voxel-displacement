# GLB-reference character polish prompt

The companion to [`GLB_CHARACTER_PROMPT.md`](GLB_CHARACTER_PROMPT.md). Use it when the build
**completed** but the result does not look like the GLB.

It is deliberately shorter than the init prompt, because it gets pasted mid-session when context
is already full. Its whole job is to make the agent **localise** the mismatch before changing
anything. A polish pass that rebuilds everything learns nothing: the earlier failure in this
project was a change justified by a measurement that had two variables moving at once, and the
number quoted as proof turned out to describe a different setting entirely.

---

Polish a GLB-referenced img2threejs character that built successfully but does not match the
reference.

## Inputs

```
GLB reference:   <ABSOLUTE_PATH_TO_GLB>
Demo id:         <subject-id>
Showcase root:   <PATH_TO_img2threejs-showcase>
Config used:     <path to the .env from the init run>
Complaint:       <in your own words — "the face is a lumpy shell", "the arm is on the wrong side">
```

## Rule for this whole pass

**One change, then re-measure.** Never two. If two things change and the number improves, you do
not know which one did it, and the next agent inherits a fact that is not true.

**Do not chase zero.** Where a residual is unavoidable, make it *one-sided* and say so. Chasing
zero error on a socket rim cost three rebuilds; two constants that made the error always-proud
fixed the actual complaint.

## Step 1 — Confirm the build is the one you are looking at

Before diagnosing geometry, rule out the boring causes. The init pipeline has two stages that
skip with a message and still exit 0.

```bash
python3 forge/next.py --state .img2threejs/state.json
ls -l public/head-<subject-id>/sdf-surfaces*.bin
git diff --stat -- src/demos/<subject-id>/
grep -A12 "Measured, on the level shipped here" src/demos/<subject-id>/surfaceData.ts
```

Read the emitted header's `nodes`, `vertices` and `bytes per vertex`. If `nodes` is smaller than
`CHARACTER_NODES`, the surface for the region you are complaining about **was never built** — the
figure you are looking at is the cross-section loft, which is convex per horizontal slice and
cannot hold a finger gap, a cupped palm or the inside of a sleeve. Stop here and re-run the init
pipeline with that node included; nothing in this document will fix it.

Also check which tier the page loaded. `x3` uses a bigger cell than `x2`, so `x3` is the *coarser*
tier and belongs in `surfaceDataLow.ts`. A swapped mapping shows up as a model that looks *worse*
at a higher quality setting, and `git diff` is the only thing that catches it.

## Step 2 — Measure where it is wrong, band by band

This is the tool that answers "where", and it takes two GLBs:

```bash
python3 forge/stage4_review/mesh_reference_compare.py <glb> <candidate.glb> \
  --bands 24 --align landmarks --json
```

**The candidate GLB has to be exported, and no script in this repo does it.** Write it once, ~20
lines, using the pattern in `$IMG2THREEJS_SHOWCASE_ROOT/pipelines/warrior/export_mesh_geometry.mjs`:
Playwright to the preview URL, `window.__IMG2THREEJS_VIEWER__.scene.getObjectByName('<root-name>')`,
`updateMatrixWorld(true)`, then three.js's `GLTFExporter`. `mesh_reference_compare.py` composes real
node matrices specifically so the `matrix` nodes that `GLTFExporter` writes can be read.

Both meshes are normalised **feet-to-height**, not bounding-box top — the top of a bbox is whatever
pokes up highest, which is exactly what differs between two subjects. Read per band:

| Field | What a non-zero value means |
|---|---|
| `widthDelta`, `depthDelta` | wrong size at that height |
| `centroidXDelta`, `centroidZDelta` | right size, wrong **place** — a limb on the wrong side passes any width-only check |
| `lowPct` / `highPct` vs `widthFull` | body vs prop: percentiles report the body, raw extent keeps a genuine prop difference visible |
| `meanBandError` | rank the bands; fix the worst one only |
| `note` | read it before trusting the alignment |

## Step 3 — Name the failure mode before touching a config

Match the measured signal to one cause. These are the modes this pipeline actually produces:

| Signal | Cause | The one change |
|---|---|---|
| Region reads lumpy/blobby, features below ~1 mm absent | cell too coarse for that node | lower **only that node's** cell in `CHARACTER_CELL_SIZES_JSON` |
| A fold that doubles back is filled in (eyelid, nostril, sleeve interior) | node still on the 2.5D loft | add that node to `CHARACTER_NODES` — no spoke count fixes this |
| Node inside-out, or exploded | `NORMAL` missing or flipped on that primitive | the SDF field's sign comes entirely from the normal, so a wrong normal *inverts* the surface rather than roughening it |
| `widthDelta` positive while silhouette IoU **falls** | spoke count above the node's density ceiling | re-run `measure_density_convergence.py`, take `min(convergence, density ceiling)` |
| Too dark or over-saturated, correct shape | colour space | vertex colours are baked sRGB-decoded to linear; `material.color` must stay white or it tints the bake |
| `centroid*Delta` non-zero, `widthDelta` ~0 | placement, not shape | fix the transform; do not touch cells or spokes |
| Right shape, wrong handedness | rotation used where a reflection was needed | negate the lateral axis only, then flip triangle winding back — `validate_chirality` catches this, `medial_lateral_bias` catches a pair wrong the *same* way on both sides |
| Looks worse at higher quality | swapped tier mapping | `git diff` the three `surfaceData*.ts` |

If the signal matches none of these, say so and stop. A change with no named mechanism is a guess
even when it improves the number.

## Step 4 — Change one thing, rebuild that node only

```bash
IMG2THREEJS_SHOWCASE_ROOT=<showcase> \
  integrations/glb_character_pipeline/build-character.sh --config <subject-id>.env --skip-build
```

`--skip-build` stops before the tsc/vite pass while you iterate on geometry. Narrow
`CHARACTER_NODES` to the node under investigation so a pass costs minutes, not an hour — then
restore the full list before the final run.

## Step 5 — Prove it improved, against the previous capture

An absolute score cannot tell improvement from regression. Keep the previous capture directory:

```bash
node integrations/glb_character_pipeline/node/capture-character.mjs \
  --demo <subject-id> --out work/cmp/<tag-new> --root-name <root>
node integrations/glb_character_pipeline/node/compare_views.mjs \
  work/cmp/<tag-new> work/cmp/<tag-previous>
python3 forge/stage4_review/interior_difference.py <baseline.png> <render.png> --json
python3 forge/stage4_review/diagnose_render_multi_angle.py --reference <ref> \
  --orbit 0.png --orbit 40.png --orbit 90.png --json
```

Measure **inside** the silhouette. Silhouette IoU reads ~11% of figure cells: a model with its face
deleted scored 0.8803 — identical to four decimals to the finished face. Re-run Step 2's band
comparison and confirm the band you targeted improved **and no other band got worse**.

Then look at the render at 0°, 40° and a grazing angle. A surface can score 2.49 mm median accuracy
and still read as a lumpy, hole-riddled shell. If the render and the metric disagree, the render is
right.

## Stop rule

Stop and report when either holds:

- the worst band's `meanBandError` is within the reference's own per-band spread, or
- **two consecutive single changes** failed to improve the targeted measurement.

The second is not failure, it is information: it means the remaining gap is not reachable by
config, and the honest output is which regions still differ and by how much. Report per band: what
was measured, which mode you named, what you changed, and what the re-measurement said — including
the changes you reverted.

"This cannot reach the requested fidelity from this reference" is a valid result.
