#!/usr/bin/env python3
"""Conservatively voxelize a static OBJ into final VXD logical chunks."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from forge._shared.voxel_displacement import INTAKE_SCHEMA, sha256_file  # noqa: E402
from forge._shared.voxel_mesh import voxelize_obj  # noqa: E402


def _read_plan(path: Path) -> dict[str, Any]:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read intake plan: {exc}") from exc
    if not isinstance(plan, dict) or plan.get("schema") != INTAKE_SCHEMA:
        raise ValueError(f"intake plan must use schema {INTAKE_SCHEMA}")
    if plan.get("status") == "blocked":
        raise ValueError("intake plan is blocked and cannot be voxelized")
    if plan.get("route") not in {"surface-displacement", "surface-voxel-mesh"}:
        raise ValueError(f"intake route {plan.get('route')!r} does not use static OBJ voxelization")
    return plan


def _source_from_plan(plan: dict[str, Any] | None, key: str) -> Path | None:
    if not plan:
        return None
    source = plan.get("inputs", {}).get(key)
    if not isinstance(source, dict) or not source.get("path"):
        return None
    return Path(str(source["path"])).expanduser().resolve()


def _verify_plan_source(plan: dict[str, Any], key: str, path: Path | None) -> None:
    source = plan.get("inputs", {}).get(key)
    if source is None:
        if path is not None:
            raise ValueError(f"{key} was not present in the intake plan; plan intake again")
        return
    if not isinstance(source, dict) or not source.get("path") or not source.get("sha256"):
        raise ValueError(f"intake plan {key} source is missing provenance")
    if path is None:
        raise ValueError(f"intake plan records {key}, but no source was supplied")
    resolved = path.expanduser().resolve()
    planned = Path(str(source["path"])).expanduser().resolve()
    if resolved != planned:
        raise ValueError(f"{key} source does not match the intake plan path")
    if not resolved.is_file() or sha256_file(resolved) != source["sha256"]:
        raise ValueError(f"planned {key} source hash changed; plan intake again")


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, help="surface-displacement or surface-voxel-mesh intake plan")
    parser.add_argument("--mesh", type=Path, help="static OBJ mesh; defaults to the plan input")
    parser.add_argument("--height", type=Path, help="optional height texture; defaults to the plan input")
    parser.add_argument("--albedo", type=Path, help="optional albedo texture; defaults to the plan input")
    resolution = parser.add_mutually_exclusive_group()
    resolution.add_argument("--voxel-size", type=float)
    resolution.add_argument("--longest-axis-voxels", type=int, default=32)
    parser.add_argument("--min-height-voxels", type=float)
    parser.add_argument("--max-height-voxels", type=float)
    parser.add_argument("--max-cells", type=int, default=4_000_000)
    parser.add_argument("--max-triangle-candidate-cells", type=int, default=1_000_000)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        plan = _read_plan(args.plan.expanduser().resolve()) if args.plan else None
        mesh_path = args.mesh.expanduser().resolve() if args.mesh else _source_from_plan(plan, "mesh")
        height_path = args.height.expanduser().resolve() if args.height else _source_from_plan(plan, "height")
        albedo_path = args.albedo.expanduser().resolve() if args.albedo else _source_from_plan(plan, "albedo")
        if not mesh_path:
            raise ValueError("--mesh is required unless the intake plan names a mesh")
        if plan:
            for key, path in (("mesh", mesh_path), ("height", height_path), ("albedo", albedo_path)):
                _verify_plan_source(plan, key, path)
        plan_mapping = plan.get("inputs", {}).get("height", {}).get("mapping", {}) if plan else {}
        voxel_range = plan_mapping.get("voxelRange", [-1.0, 1.0])
        min_height = args.min_height_voxels
        max_height = args.max_height_voxels
        if plan:
            if min_height is None:
                min_height = float(voxel_range[0])
            if max_height is None:
                max_height = float(voxel_range[1])
        min_height = -1.0 if min_height is None else min_height
        max_height = 1.0 if max_height is None else max_height
        artifact = voxelize_obj(
            mesh_path=mesh_path,
            height_path=height_path,
            albedo_path=albedo_path,
            voxel_size=args.voxel_size,
            longest_axis_voxels=args.longest_axis_voxels,
            min_height_voxels=min_height,
            max_height_voxels=max_height,
            max_cells=args.max_cells,
            max_triangle_candidate_cells=args.max_triangle_candidate_cells,
        )
        rendered = json.dumps(artifact, indent=2, ensure_ascii=False) + "\n"
        _atomic_write(args.out.expanduser().resolve(), rendered)
        print(rendered, end="")
        return 0
    except Exception as exc:  # noqa: BLE001 - stable CLI errors are easier to automate
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
