#!/usr/bin/env python3
"""Plan an opt-in voxel-displacement conversion from prompt, mesh, or textures.

This stage does not claim to render Daniel Schroeder's unpublished technique.
It records provenance, checks whether a source is suitable for surface
displacement, and selects one of the distinct conversion tracks:

* static UV mesh plus height texture -> displaced environment surface;
* static thin/prop mesh -> baked surface-voxel object;
* skinned or morphing mesh -> baked voxel animation frames; or
* text prompt -> optional Codex ImageGen art-direction reference -> authored or
  fitted renderer-compatible model intake before conversion.

Pure Python 3.10+ standard library.  GLB inspection reuses probe_glb.py and
image decoding reuses the existing deterministic intake decoder.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "forge" / "_shared"))

from forge._shared.voxel_displacement import (  # noqa: E402
    INTAKE_SCHEMA,
    build_reference_brief,
    height_fields,
    sha256_file,
)
from forge.stage1_intake.extract_pbr_evidence import load_image  # noqa: E402
from forge.stage1_intake.probe_glb import parse_glb, probe_glb  # noqa: E402


ASSET_ROLES = {"auto", "environment", "prop", "character", "material"}


def _resolve_index(raw: str, count: int, label: str, line_number: int) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"OBJ line {line_number}: invalid {label} index {raw!r}") from exc
    if value == 0:
        raise ValueError(f"OBJ line {line_number}: {label} index must not be zero")
    resolved = value - 1 if value > 0 else count + value
    if not 0 <= resolved < count:
        raise ValueError(f"OBJ line {line_number}: {label} index {value} is out of range")
    return resolved


def probe_obj(path: Path) -> dict[str, Any]:
    """Inspect the OBJ subset required to route voxel-displacement intake."""

    vertices: list[tuple[float, float, float]] = []
    uv_count = 0
    normal_count = 0
    triangle_count = 0
    polygon_count = 0
    material_libraries: list[str] = []
    material_names: set[str] = set()
    object_names: set[str] = set()
    group_names: set[str] = set()
    corner_count = 0
    uv_corner_count = 0
    normal_corner_count = 0
    edge_counts: Counter[tuple[int, int]] = Counter()

    for line_number, original in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        keyword = fields[0]
        values = fields[1:]
        if keyword == "v":
            if len(values) < 3:
                raise ValueError(f"OBJ line {line_number}: vertex needs at least three coordinates")
            try:
                point = tuple(float(value) for value in values[:3])
            except ValueError as exc:
                raise ValueError(f"OBJ line {line_number}: vertex contains a non-numeric coordinate") from exc
            if not all(math.isfinite(value) for value in point):
                raise ValueError(f"OBJ line {line_number}: vertex coordinates must be finite")
            vertices.append(point)  # type: ignore[arg-type]
        elif keyword == "vt":
            if len(values) < 2:
                raise ValueError(f"OBJ line {line_number}: texture coordinate needs at least two components")
            try:
                texture_coordinate = tuple(float(value) for value in values[:3])
            except ValueError as exc:
                raise ValueError(f"OBJ line {line_number}: texture coordinate contains a non-numeric value") from exc
            if not all(math.isfinite(value) for value in texture_coordinate):
                raise ValueError(f"OBJ line {line_number}: texture coordinates must be finite")
            uv_count += 1
        elif keyword == "vn":
            if len(values) < 3:
                raise ValueError(f"OBJ line {line_number}: normal needs three components")
            try:
                normal = tuple(float(value) for value in values[:3])
            except ValueError as exc:
                raise ValueError(f"OBJ line {line_number}: normal contains a non-numeric value") from exc
            if not all(math.isfinite(value) for value in normal) or math.sqrt(sum(value * value for value in normal)) == 0:
                raise ValueError(f"OBJ line {line_number}: normal must be finite and non-zero")
            normal_count += 1
        elif keyword == "mtllib" and values:
            material_libraries.extend(values)
        elif keyword == "usemtl" and values:
            material_names.add(" ".join(values))
        elif keyword == "o" and values:
            object_names.add(" ".join(values))
        elif keyword == "g" and values:
            group_names.add(" ".join(values))
        elif keyword == "f":
            if len(values) < 3:
                raise ValueError(f"OBJ line {line_number}: face needs at least three corners")
            polygon_count += 1
            parsed: list[tuple[int, int | None, int | None]] = []
            for token in values:
                parts = token.split("/")
                vertex = _resolve_index(parts[0], len(vertices), "vertex", line_number)
                uv = None
                normal = None
                if len(parts) > 1 and parts[1]:
                    uv = _resolve_index(parts[1], uv_count, "texture", line_number)
                if len(parts) > 2 and parts[2]:
                    normal = _resolve_index(parts[2], normal_count, "normal", line_number)
                parsed.append((vertex, uv, normal))
                corner_count += 1
                uv_corner_count += uv is not None
                normal_corner_count += normal is not None
            for index in range(1, len(parsed) - 1):
                triangle_count += 1
                triangle = (parsed[0][0], parsed[index][0], parsed[index + 1][0])
                if len(set(triangle)) != 3:
                    continue
                for start, end in ((triangle[0], triangle[1]), (triangle[1], triangle[2]), (triangle[2], triangle[0])):
                    edge_counts[tuple(sorted((start, end)))] += 1

    if not vertices:
        raise ValueError("OBJ contains no vertices")
    if triangle_count <= 0:
        raise ValueError("OBJ contains no triangulatable faces")
    minimum = [min(point[axis] for point in vertices) for axis in range(3)]
    maximum = [max(point[axis] for point in vertices) for axis in range(3)]
    boundary_edges = sum(1 for count in edge_counts.values() if count == 1)
    non_manifold_edges = sum(1 for count in edge_counts.values() if count > 2)
    uv_fraction = uv_corner_count / corner_count if corner_count else 0.0
    normal_fraction = normal_corner_count / corner_count if corner_count else 0.0
    warnings: list[str] = []
    if uv_fraction < 1.0:
        warnings.append("OBJ does not provide texture coordinates for every face corner")
    if normal_fraction < 1.0:
        warnings.append("OBJ does not provide shading normals for every face corner")
    if boundary_edges:
        warnings.append("OBJ is open; signed-distance displacement needs an oriented unsigned narrow-band route")
    if non_manifold_edges:
        warnings.append("OBJ has non-manifold edges; route to conservative surface-shell voxelization")
    return {
        "kind": "obj",
        "path": str(path),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "vertexCount": len(vertices),
        "polygonCount": polygon_count,
        "triangleCount": triangle_count,
        "bounds": {
            "space": "mesh-local",
            "min": minimum,
            "max": maximum,
            "size": [maximum[axis] - minimum[axis] for axis in range(3)],
        },
        "attributes": {
            "uvCornerFraction": round(uv_fraction, 6),
            "normalCornerFraction": round(normal_fraction, 6),
        },
        "topology": {
            "boundaryEdgeCount": boundary_edges,
            "nonManifoldEdgeCount": non_manifold_edges,
            "watertightCandidate": boundary_edges == 0 and non_manifold_edges == 0,
        },
        "objects": sorted(object_names),
        "groups": sorted(group_names),
        "materials": sorted(material_names),
        "materialLibraries": material_libraries,
        "animated": False,
        "warnings": warnings,
    }


def _glb_route_probe(path: Path) -> dict[str, Any]:
    result = probe_glb(path)
    document, _bin_payload, _binary = parse_glb(path)
    raw_meshes = document.get("meshes", []) if isinstance(document.get("meshes", []), list) else []
    raw_primitives = [
        primitive
        for raw_mesh in raw_meshes
        if isinstance(raw_mesh, dict)
        for primitive in (
            raw_mesh.get("primitives", [])
            if isinstance(raw_mesh.get("primitives", []), list)
            else []
        )
        if isinstance(primitive, dict)
    ]
    has_morph_targets = any(
        isinstance(primitive.get("targets"), list) and bool(primitive["targets"])
        for primitive in raw_primitives
    )
    primitives = [
        primitive
        for mesh in result.get("meshes", [])
        for primitive in mesh.get("primitives", [])
        if isinstance(primitive, dict)
    ]
    uv_ready = bool(primitives) and all("TEXCOORD_0" in primitive.get("attributes", []) for primitive in primitives)
    normal_ready = bool(primitives) and all("NORMAL" in primitive.get("attributes", []) for primitive in primitives)
    position_ready = bool(primitives) and all("POSITION" in primitive.get("attributes", []) for primitive in primitives)
    triangles_only = bool(primitives) and all(primitive.get("mode", 4) == 4 for primitive in primitives)
    scene = result.get("scene", {})
    has_skin = bool(scene.get("skinCount", 0))
    has_animation_clips = bool(scene.get("animationCount", 0))
    deforming = has_skin or has_morph_targets
    rigid_animated = has_animation_clips and not deforming
    warnings = list(result.get("warnings", []))
    if not uv_ready:
        warnings.append("GLB does not provide TEXCOORD_0 on every primitive")
    if not normal_ready:
        warnings.append("GLB does not provide NORMAL on every primitive")
    if not position_ready:
        warnings.append("GLB does not provide POSITION on every primitive")
    if not triangles_only:
        warnings.append("GLB contains non-triangle primitive modes")
    return {
        "kind": "glb",
        "path": result["path"],
        "sha256": result["sha256"],
        "bytes": result["bytes"],
        "bounds": result.get("bounds"),
        "scene": scene,
        "attributes": {
            "uvReady": uv_ready,
            "normalReady": normal_ready,
            "positionReady": position_ready,
            "trianglesOnly": triangles_only,
        },
        "animation": {
            "hasSkin": has_skin,
            "hasMorphTargets": has_morph_targets,
            "hasAnimationClips": has_animation_clips,
            "deforming": deforming,
            "rigidAnimated": rigid_animated,
        },
        "animated": deforming or rigid_animated,
        "deforming": deforming,
        "rigidAnimated": rigid_animated,
        "sourceProbe": result,
        "warnings": sorted(set(warnings)),
    }


def probe_mesh(path: Path) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"mesh does not exist: {path}")
    suffix = path.suffix.lower()
    if suffix == ".obj":
        return probe_obj(path)
    if suffix == ".glb":
        return _glb_route_probe(path)
    raise ValueError("mesh must be an OBJ or binary glTF (.glb) file in the initial conversion slice")


def probe_height(path: Path, *, min_voxels: float, max_voxels: float) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"height texture does not exist: {path}")
    width, height, pixels, decoder_warnings = load_image(path)
    fields = height_fields(
        width,
        height,
        pixels,
        min_voxels=min_voxels,
        max_voxels=max_voxels,
    )
    warnings = list(decoder_warnings)
    if fields["statistics"]["chromaticPixelFraction"] > 0.01:
        warnings.append("height source is chromatic; conversion uses BT.709 luma over raw encoded RGB bytes")
    return {
        "kind": "height-texture",
        "path": str(path),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "width": width,
        "height": height,
        "mapping": fields["mapping"],
        "statistics": fields["statistics"],
        "warnings": warnings,
    }


def probe_albedo(path: Path) -> dict[str, Any]:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"albedo texture does not exist: {path}")
    width, height, _pixels, warnings = load_image(path)
    return {
        "kind": "albedo-texture",
        "path": str(path),
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "width": width,
        "height": height,
        "warnings": warnings,
    }


def _mesh_uv_ready(mesh: dict[str, Any] | None) -> bool:
    if not mesh:
        return False
    if mesh["kind"] == "obj":
        return mesh["attributes"]["uvCornerFraction"] == 1.0
    return bool(mesh["attributes"]["uvReady"])


def choose_route(
    *,
    asset_role: str,
    mesh: dict[str, Any] | None,
    height: dict[str, Any] | None,
    albedo: dict[str, Any] | None,
    prompt: str | None,
) -> tuple[str, str, list[str], list[str]]:
    findings: list[str] = []
    next_actions: list[str] = []
    if mesh and mesh.get("kind") == "glb" and not mesh.get("attributes", {}).get("positionReady"):
        findings.append("GLB conversion needs POSITION on every primitive")
        next_actions.append("repair or remove primitives without positions and plan intake again")
        return "surface-voxel-mesh", "blocked", findings, next_actions
    if mesh and mesh.get("kind") == "glb" and not mesh.get("attributes", {}).get("trianglesOnly"):
        findings.append("the initial voxel conversion slice accepts triangle primitives only")
        next_actions.append("convert point, line, strip, or fan primitives to explicit triangles")
        return "surface-voxel-mesh", "blocked", findings, next_actions
    if mesh and mesh.get("deforming"):
        findings.append("skinning or morph deformation is incompatible with static surface preprocessing")
        next_actions.extend(
            [
                "sample selected clips into fixed poses on a shared asset-local grid",
                "bake each pose as a surface-only voxel frame and preserve root motion separately",
            ]
        )
        return "baked-surface-voxel-frames", "planned", findings, next_actions

    if mesh and mesh.get("rigidAnimated"):
        findings.append("GLB animation has no skin or morph targets and is treated as rigid-node animation")
        next_actions.extend(
            [
                "voxelize each rigid mesh once in its local grid",
                "preserve node pivots, hierarchy, animation channels, sockets, and colliders",
            ]
        )
        return "surface-voxel-mesh", "planned", findings, next_actions

    if height and height.get("statistics", {}).get("nonOpaquePixelFraction", 0.0) > 0.0:
        findings.append("height texture contains non-opaque pixels but no alpha-to-height or mask policy was declared")
        next_actions.append("flatten the height texture to opaque data or add an explicit alpha policy")
        return "surface-displacement" if mesh else "voxel-displacement-material", "blocked", findings, next_actions

    if mesh and height:
        if not _mesh_uv_ready(mesh):
            findings.append("surface displacement needs complete UV coverage for height lookup")
            next_actions.append("unwrap the mesh or choose conservative surface-shell voxelization")
            return "surface-displacement", "blocked", findings, next_actions
        if mesh["kind"] == "obj" and mesh["topology"]["nonManifoldEdgeCount"]:
            findings.append("non-manifold geometry cannot establish a stable displaced surface sign")
            next_actions.append("repair topology or choose conservative surface-shell voxelization")
            return "surface-displacement", "blocked", findings, next_actions
        next_actions.extend(
            [
                "bake the height texture into whole-voxel and continuous-normal channels",
                "run thickness and sharp-edge rejection before renderer conversion",
                "retain the low-poly source mesh as collision and navigation authority",
            ]
        )
        return "surface-displacement", "ready-to-bake", findings, next_actions

    if mesh:
        if asset_role == "environment":
            findings.append("environment surface displacement needs an explicit height texture")
            next_actions.append("supply --height and verify UV coverage, or explicitly choose surface-shell conversion")
            return "surface-displacement", "needs-height-texture", findings, next_actions
        next_actions.extend(
            [
                "conservatively voxelize triangle-box intersections into a surface shell",
                "sample albedo and source-surface normals per occupied cell when available",
            ]
        )
        return "surface-voxel-mesh", "planned", findings, next_actions

    if height:
        findings.append("texture-only displacement has no target projection or world dimensions yet")
        next_actions.extend(
            [
                "bake the texture channels",
                "choose a plane, terrain, box, cylinder, or explicit target mesh before rendering",
            ]
        )
        return "voxel-displacement-material", "ready-to-bake", findings, next_actions

    if albedo:
        findings.append("albedo alone does not define voxel displacement geometry")
        next_actions.append("supply a calibrated height texture and target projection")
        return "texture-reference-only", "blocked", findings, next_actions

    if prompt:
        next_actions.append("verify that the active Codex ImageGen route satisfies the requested gpt-image-2 model")
        next_actions.append("run the optional Codex ImageGen art-direction reference call")
        if asset_role == "material":
            next_actions.extend(
                [
                    "derive and validate the height candidate and oblique relief review one at a time",
                    "calibrate the generated height estimate before assigning metric voxel displacement",
                ]
            )
        else:
            next_actions.extend(
                [
                    "validate the locked orthographic reference panels for silhouette and proportions",
                    "author or fit a renderer-compatible low-poly triangle mesh; do not voxelize the sprite sheet",
                    "provide the mesh (and albedo/height data when applicable) for the selected displacement or surface-voxel route",
                ]
            )
        return "generated-reference-intake", "needs-image-generation", findings, next_actions

    raise ValueError("at least one prompt, mesh, albedo texture, or height texture is required")


def build_plan(
    *,
    name: str,
    asset_role: str,
    prompt: str | None = None,
    mesh_path: Path | None = None,
    albedo_path: Path | None = None,
    height_path: Path | None = None,
    min_height_voxels: float = -1.0,
    max_height_voxels: float = 1.0,
) -> dict[str, Any]:
    if asset_role not in ASSET_ROLES:
        raise ValueError(f"unsupported asset role {asset_role!r}")
    mesh = probe_mesh(mesh_path) if mesh_path else None
    albedo = probe_albedo(albedo_path) if albedo_path else None
    height = (
        probe_height(height_path, min_voxels=min_height_voxels, max_voxels=max_height_voxels)
        if height_path
        else None
    )
    route, status, findings, next_actions = choose_route(
        asset_role=asset_role,
        mesh=mesh,
        height=height,
        albedo=albedo,
        prompt=prompt,
    )
    warnings = sorted(
        {
            warning
            for source in (mesh, albedo, height)
            if source
            for warning in source.get("warnings", [])
        }
    )
    if albedo and height and (albedo["width"], albedo["height"]) != (height["width"], height["height"]):
        findings.append("albedo and height dimensions differ, so the deterministic baker will refuse the pair")
        next_actions.append("resample one texture explicitly, record that operation, and plan intake again")
        status = "blocked"
    subject_kind = "object" if asset_role in {"auto", "prop"} else asset_role
    reference_brief = build_reference_brief(prompt, subject_kind=subject_kind) if prompt else None
    return {
        "schema": INTAKE_SCHEMA,
        "name": name,
        "profile": "voxel-displacement-inspired",
        "assetRole": asset_role,
        "route": route,
        "status": status,
        "inputs": {
            "prompt": prompt,
            "mesh": mesh,
            "albedo": albedo,
            "height": height,
        },
        "referenceGeneration": reference_brief,
        "targetAssetProfile": (
            reference_brief.get("targetAssetProfile") if reference_brief else None
        ),
        "findings": findings,
        "warnings": sorted(set(warnings)),
        "nextActions": next_actions,
        "representationBoundary": {
            "surfaceDisplacement": "static UV-mapped environment surfaces with whole-voxel height and continuous-height shading normals",
            "surfaceVoxelMesh": "small or thin props baked directly from triangle geometry",
            "surfaceVoxelFrames": "deforming animation baked as discrete posed voxel frames without continuous blending",
        },
        "honesty": "Inspired by published behavior. The original renderer and preprocessing implementation are not public, so parity requires independent runtime evidence.",
    }


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="voxel-displacement-asset")
    parser.add_argument("--asset-role", choices=sorted(ASSET_ROLES), default="auto")
    parser.add_argument("--prompt")
    parser.add_argument("--mesh", type=Path)
    parser.add_argument("--albedo", type=Path)
    parser.add_argument("--height", type=Path)
    parser.add_argument("--min-height-voxels", type=float, default=-1.0)
    parser.add_argument("--max-height-voxels", type=float, default=1.0)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        plan = build_plan(
            name=args.name,
            asset_role=args.asset_role,
            prompt=args.prompt,
            mesh_path=args.mesh,
            albedo_path=args.albedo,
            height_path=args.height,
            min_height_voxels=args.min_height_voxels,
            max_height_voxels=args.max_height_voxels,
        )
        rendered = json.dumps(plan, indent=2, ensure_ascii=False) + "\n"
        if args.out:
            _atomic_write(args.out.expanduser().resolve(), rendered)
        print(rendered, end="")
        return 0 if plan["status"] != "blocked" else 1
    except Exception as exc:  # noqa: BLE001 - CLI emits stable, traceback-free failures
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
