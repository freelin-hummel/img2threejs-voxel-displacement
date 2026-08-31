#!/usr/bin/env python3
"""Bake renderer-neutral voxel-displacement texture channels.

The output is a JSON V1 bake artifact with compressed, checksummed channels:

* continuous 8-bit height for sub-voxel shading;
* signed whole-voxel height steps for geometry;
* provisional octahedral texture-space normals derived from continuous height; and
* optional sRGB RGBA albedo.

This is the first deterministic vertical slice of the voxel-displacement fork.
It deliberately does not claim to implement the unpublished renderer, arbitrary
mesh shell mapping, conservative object voxelization, or animated frame baking.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from forge._shared.voxel_displacement import (  # noqa: E402
    BAKE_SCHEMA,
    INTAKE_SCHEMA,
    decode_channel,
    encode_channel,
    height_fields,
    sha256_file,
)
from forge.stage1_intake.extract_pbr_evidence import load_image  # noqa: E402


def _read_plan(path: Path) -> dict[str, Any]:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read intake plan: {exc}") from exc
    if not isinstance(plan, dict) or plan.get("schema") != INTAKE_SCHEMA:
        raise ValueError(f"intake plan must use schema {INTAKE_SCHEMA}")
    if plan.get("status") == "blocked":
        raise ValueError("intake plan is blocked and cannot be baked")
    if plan.get("route") not in {"surface-displacement", "voxel-displacement-material"}:
        raise ValueError(f"intake route {plan.get('route')!r} does not use the displacement texture bake")
    return plan


def _source_from_plan(plan: dict[str, Any] | None, key: str) -> Path | None:
    if not plan:
        return None
    value = plan.get("inputs", {}).get(key)
    if not isinstance(value, dict) or not value.get("path"):
        return None
    return Path(str(value["path"])).expanduser().resolve()


def _verify_planned_source(plan: dict[str, Any], key: str, actual_path: Path | None) -> dict[str, Any] | None:
    inputs = plan.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("intake plan inputs must be an object")
    planned = inputs.get(key)
    if planned is None:
        if actual_path is not None:
            raise ValueError(f"{key} input was not recorded in the intake plan; plan intake again")
        return None
    if not isinstance(planned, dict) or not planned.get("path") or not planned.get("sha256"):
        raise ValueError(f"intake plan {key} source is missing path or hash provenance")
    if actual_path is None:
        raise ValueError(f"intake plan records a {key} source but the baker did not receive it")
    resolved = actual_path.expanduser().resolve()
    planned_path = Path(str(planned["path"])).expanduser().resolve()
    if resolved != planned_path:
        raise ValueError(f"{key} source does not match the intake plan path; plan intake again")
    if not resolved.is_file():
        raise ValueError(f"planned {key} source does not exist: {resolved}")
    current_hash = sha256_file(resolved)
    if current_hash != planned["sha256"]:
        raise ValueError(f"planned {key} source hash changed; plan intake again")
    planned_bytes = planned.get("bytes")
    if isinstance(planned_bytes, int) and not isinstance(planned_bytes, bool) and resolved.stat().st_size != planned_bytes:
        raise ValueError(f"planned {key} source size changed; plan intake again")
    return planned


def _rgba_bytes(pixels: list[tuple[int, int, int, int]]) -> bytes:
    return bytes(channel for pixel in pixels for channel in pixel)


def bake(
    *,
    height_path: Path,
    albedo_path: Path | None = None,
    plan: dict[str, Any] | None = None,
    min_height_voxels: float = -1.0,
    max_height_voxels: float = 1.0,
    normal_strength: float = 1.0,
) -> dict[str, Any]:
    height_path = height_path.expanduser().resolve()
    if not height_path.is_file():
        raise ValueError(f"height texture does not exist: {height_path}")
    if plan:
        _verify_planned_source(plan, "height", height_path)
        _verify_planned_source(plan, "albedo", albedo_path)
    width, height, height_pixels, height_warnings = load_image(height_path)
    fields = height_fields(
        width,
        height,
        height_pixels,
        min_voxels=min_height_voxels,
        max_voxels=max_height_voxels,
        normal_strength=normal_strength,
    )
    warnings = list(height_warnings)
    if fields["statistics"]["nonOpaquePixelFraction"] > 0.0:
        raise ValueError("height texture contains non-opaque pixels; flatten it or declare an alpha policy before baking")
    if fields["statistics"]["chromaticPixelFraction"] > 0.01:
        warnings.append("height source is chromatic; bake used BT.709 luma over raw encoded RGB bytes")

    channels = {
        "heightUnorm8": {
            **encode_channel(fields["heightUnorm8"]),
            "components": 1,
            "componentType": "u8",
            "semantic": "continuous-height",
            "colorSpace": "linear-data",
        },
        "heightStepsI8": {
            **encode_channel(fields["heightStepsI8"]),
            "components": 1,
            "componentType": "i8-twos-complement",
            "semantic": "whole-voxel-geometry-step",
            "colorSpace": "linear-data",
        },
        "surfaceNormalOct8": {
            **encode_channel(fields["surfaceNormalOct8"]),
            "components": 2,
            "componentType": "u8",
            "semantic": "octahedral-texture-space-normal-provisional",
            "colorSpace": "linear-data",
        },
    }

    albedo_source = None
    if albedo_path:
        albedo_path = albedo_path.expanduser().resolve()
        if not albedo_path.is_file():
            raise ValueError(f"albedo texture does not exist: {albedo_path}")
        albedo_width, albedo_height, albedo_pixels, albedo_warnings = load_image(albedo_path)
        if (albedo_width, albedo_height) != (width, height):
            raise ValueError(
                f"albedo dimensions {albedo_width}x{albedo_height} do not match height {width}x{height}; "
                "resample explicitly before baking"
            )
        warnings.extend(albedo_warnings)
        channels["albedoRgba8"] = {
            **encode_channel(_rgba_bytes(albedo_pixels)),
            "components": 4,
            "componentType": "u8",
            "semantic": "base-color-alpha",
            "colorSpace": "srgb",
        }
        albedo_source = {
            "path": str(albedo_path),
            "sha256": sha256_file(albedo_path),
            "bytes": albedo_path.stat().st_size,
        }

    mesh_source = None
    if plan:
        mesh = plan.get("inputs", {}).get("mesh")
        if isinstance(mesh, dict):
            mesh_path = Path(str(mesh.get("path", ""))).expanduser().resolve()
            _verify_planned_source(plan, "mesh", mesh_path)
            mesh_source = {
                key: mesh.get(key)
                for key in ("kind", "path", "sha256", "bytes", "bounds", "animated", "deforming", "rigidAnimated", "animation")
                if key in mesh
            }

    artifact = {
        "schema": BAKE_SCHEMA,
        "kind": "voxel-displacement-texture-bake",
        "profile": "voxel-displacement-inspired",
        "dimensions": {"width": width, "height": height, "texelCount": width * height},
        "sources": {
            "height": {
                "path": str(height_path),
                "sha256": sha256_file(height_path),
                "bytes": height_path.stat().st_size,
            },
            "albedo": albedo_source,
            "mesh": mesh_source,
        },
        "mapping": fields["mapping"],
        "statistics": fields["statistics"],
        "recipe": {
            "heightChannel": "raw-rgb-data-bt709-luma-u8",
            "minimumHeightVoxels": min_height_voxels,
            "maximumHeightVoxels": max_height_voxels,
            "geometryQuantization": "nearest-whole-voxel",
            "normalSource": "unquantized-height-gradient",
            "normalOctQuantization": "unorm8-round-to-nearest-ties-to-even",
            "normalStrength": normal_strength,
            "gridSpace": "target-surface-local",
        },
        "channels": channels,
        "rendererContract": {
            "geometry": "sample heightStepsI8 in UV space and offset the surface by whole voxel cells",
            "lighting": "treat surfaceNormalOct8 as a provisional texture-space field until target scale, aspect, tangent basis, and wrap are supplied",
            "albedo": "sample albedoRgba8 as sRGB when present",
            "collision": "keep the undisplaced low-poly source mesh as coarse gameplay authority",
            "exactQueries": "use a displacement-aware query only when gameplay must match visible voxel relief",
        },
        "warnings": sorted(set(warnings)),
        "unimplemented": [
            "arbitrary mesh shell parameterization and sharp-corner stitching",
            "world-scale tangent-basis and texture-wrap calibration for baked normals",
            "minimum-thickness and curvature rejection heatmaps",
            "conservative triangle-box surface voxelization for props",
            "skinned or morph-target animation frame baking",
            "WebGPU hierarchical DDA rendering and explicit fallback",
        ],
        "honesty": "This bake reproduces published input semantics, not the unpublished Schroeder preprocessing or renderer.",
    }
    errors = validate_bake(artifact)
    if errors:
        raise ValueError("internal bake validation failed: " + "; ".join(errors))
    return artifact


def validate_bake(artifact: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(artifact, dict):
        return ["artifact must be an object"]
    if artifact.get("schema") != BAKE_SCHEMA:
        errors.append(f"schema must be {BAKE_SCHEMA}")
    if artifact.get("kind") != "voxel-displacement-texture-bake":
        errors.append("kind must be voxel-displacement-texture-bake")
    if artifact.get("profile") != "voxel-displacement-inspired":
        errors.append("profile must be voxel-displacement-inspired")
    dimensions = artifact.get("dimensions")
    if not isinstance(dimensions, dict):
        errors.append("dimensions must be an object")
        return errors
    width, height = dimensions.get("width"), dimensions.get("height")
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0:
        errors.append("dimensions.width must be a positive integer")
    if not isinstance(height, int) or isinstance(height, bool) or height <= 0:
        errors.append("dimensions.height must be a positive integer")
    if errors:
        return errors
    texels = width * height
    if dimensions.get("texelCount") != texels:
        errors.append(f"dimensions.texelCount must be {texels}")
    expected = {
        "heightUnorm8": (texels, 1, "u8", "continuous-height", "linear-data"),
        "heightStepsI8": (texels, 1, "i8-twos-complement", "whole-voxel-geometry-step", "linear-data"),
        "surfaceNormalOct8": (
            texels * 2,
            2,
            "u8",
            "octahedral-texture-space-normal-provisional",
            "linear-data",
        ),
        "albedoRgba8": (texels * 4, 4, "u8", "base-color-alpha", "srgb"),
    }
    channels = artifact.get("channels")
    if not isinstance(channels, dict):
        errors.append("channels must be an object")
        return errors
    for required in ("heightUnorm8", "heightStepsI8", "surfaceNormalOct8"):
        if required not in channels:
            errors.append(f"channels.{required} is required")
    for name, channel in channels.items():
        if name not in expected:
            errors.append(f"channels.{name} is not recognized")
            continue
        if not isinstance(channel, dict):
            errors.append(f"channels.{name} must be an object")
            continue
        expected_bytes, components, component_type, semantic, color_space = expected[name]
        for field, value in (
            ("components", components),
            ("componentType", component_type),
            ("semantic", semantic),
            ("colorSpace", color_space),
        ):
            if channel.get(field) != value:
                errors.append(f"channels.{name}.{field} must be {value!r}")
        try:
            payload = decode_channel(channel, max_decoded_bytes=expected_bytes)
        except ValueError as exc:
            errors.append(f"channels.{name}: {exc}")
            continue
        if len(payload) != expected_bytes:
            errors.append(f"channels.{name} decoded length must be {expected_bytes}")
    mapping = artifact.get("mapping")
    voxel_range = mapping.get("voxelRange") if isinstance(mapping, dict) else None
    if (
        not isinstance(voxel_range, list)
        or len(voxel_range) != 2
        or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in voxel_range)
        or voxel_range[0] >= voxel_range[1]
        or voxel_range[0] < -127
        or voxel_range[1] > 127
    ):
        errors.append("mapping.voxelRange must contain increasing finite numbers within -127..127")
    if isinstance(mapping, dict):
        for field, value in (
            ("sourceRange", [0, 255]),
            ("quantization", "nearest-whole-voxel"),
            ("roundingTies", "to-even"),
            ("sourceInterpretation", "raw-rgb-data-bt709-luma-u8"),
        ):
            if mapping.get(field) != value:
                errors.append(f"mapping.{field} must be {value!r}")
    recipe = artifact.get("recipe")
    if not isinstance(recipe, dict):
        errors.append("recipe must be an object")
    else:
        expected_recipe = {
            "heightChannel": "raw-rgb-data-bt709-luma-u8",
            "geometryQuantization": "nearest-whole-voxel",
            "normalSource": "unquantized-height-gradient",
            "normalOctQuantization": "unorm8-round-to-nearest-ties-to-even",
            "gridSpace": "target-surface-local",
        }
        for field, value in expected_recipe.items():
            if recipe.get(field) != value:
                errors.append(f"recipe.{field} must be {value!r}")
        normal_strength = recipe.get("normalStrength")
        if (
            not isinstance(normal_strength, (int, float))
            or isinstance(normal_strength, bool)
            or not math.isfinite(normal_strength)
            or normal_strength <= 0
        ):
            errors.append("recipe.normalStrength must be a positive finite number")
        if isinstance(voxel_range, list) and len(voxel_range) == 2:
            if recipe.get("minimumHeightVoxels") != voxel_range[0]:
                errors.append("recipe.minimumHeightVoxels must match mapping.voxelRange[0]")
            if recipe.get("maximumHeightVoxels") != voxel_range[1]:
                errors.append("recipe.maximumHeightVoxels must match mapping.voxelRange[1]")
    return errors


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, help="voxel-displacement intake plan")
    parser.add_argument("--height", type=Path, help="height texture; defaults to the plan input")
    parser.add_argument("--albedo", type=Path, help="albedo texture; defaults to the plan input")
    parser.add_argument("--min-height-voxels", type=float)
    parser.add_argument("--max-height-voxels", type=float)
    parser.add_argument("--normal-strength", type=float, default=1.0)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        plan = _read_plan(args.plan.expanduser().resolve()) if args.plan else None
        height_path = args.height.expanduser().resolve() if args.height else _source_from_plan(plan, "height")
        albedo_path = args.albedo.expanduser().resolve() if args.albedo else _source_from_plan(plan, "albedo")
        if not height_path:
            raise ValueError("--height is required unless the intake plan names a height texture")
        plan_mapping = plan.get("inputs", {}).get("height", {}).get("mapping", {}) if plan else {}
        plan_range = plan_mapping.get("voxelRange", [-1.0, 1.0])
        min_height = args.min_height_voxels if args.min_height_voxels is not None else float(plan_range[0])
        max_height = args.max_height_voxels if args.max_height_voxels is not None else float(plan_range[1])
        artifact = bake(
            height_path=height_path,
            albedo_path=albedo_path,
            plan=plan,
            min_height_voxels=min_height,
            max_height_voxels=max_height,
            normal_strength=args.normal_strength,
        )
        rendered = json.dumps(artifact, indent=2, ensure_ascii=False) + "\n"
        _atomic_write(args.out.expanduser().resolve(), rendered)
        print(rendered, end="")
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI emits stable, traceback-free failures
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
