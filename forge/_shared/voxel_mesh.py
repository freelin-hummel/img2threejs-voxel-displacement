"""Deterministic CPU surface voxelization for the voxel-displacement fork.

This module intentionally handles a narrow, testable first slice: static OBJ
triangles, optional nearest-sampled height/albedo maps, and conservative
triangle-box surface occupancy. Height steps are resolved into final triangle
positions before cells are emitted; VXD traversal never applies a second
displacement.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from forge._shared.voxel_displacement import height_fields, sha256_file
from forge.stage1_intake.extract_pbr_evidence import load_image


VOXEL_OBJECT_SCHEMA = "img2threejs.voxel-object-bake.v1"
CHUNK_EDGE = 8
MAX_VOXEL_CELLS = 4_000_000
MAX_TRIANGLE_CANDIDATE_CELLS = 1_000_000

Vec3 = tuple[float, float, float]
Vec2 = tuple[float, float]


@dataclass(frozen=True)
class ObjTriangle:
    positions: tuple[Vec3, Vec3, Vec3]
    uvs: tuple[Vec2, Vec2, Vec2] | None
    normals: tuple[Vec3, Vec3, Vec3] | None
    material: int
    source_index: int


@dataclass(frozen=True)
class VoxelCell:
    coordinate: tuple[int, int, int]
    albedo: tuple[int, int, int, int]
    normal: Vec3
    material: int
    flags: int = 0


def _finite_tuple(values: Iterable[float], count: int, label: str, line_number: int) -> tuple[float, ...]:
    items = tuple(float(value) for value in values)
    if len(items) < count or not all(math.isfinite(value) for value in items[:count]):
        raise ValueError(f"OBJ line {line_number}: {label} must contain {count} finite values")
    return items[:count]


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


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(a: Vec3, value: float) -> Vec3:
    return (a[0] * value, a[1] * value, a[2] * value)


def _dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _length(value: Vec3) -> float:
    return math.sqrt(_dot(value, value))


def _normalize(value: Vec3) -> Vec3:
    length = _length(value)
    if length <= 1e-12 or not math.isfinite(length):
        return (0.0, 0.0, 1.0)
    return (value[0] / length, value[1] / length, value[2] / length)


def _face_normal(positions: tuple[Vec3, Vec3, Vec3]) -> Vec3:
    return _normalize(_cross(_sub(positions[1], positions[0]), _sub(positions[2], positions[0])))


def parse_obj_triangles(path: Path, *, require_uv: bool = False) -> tuple[list[ObjTriangle], list[str]]:
    """Parse the OBJ subset needed by conservative surface baking."""

    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"OBJ does not exist: {path}")
    vertices: list[Vec3] = []
    uvs: list[Vec2] = []
    normals: list[Vec3] = []
    material_slots: dict[str, int] = {}
    active_material = 0
    triangles: list[ObjTriangle] = []
    warnings: list[str] = []

    for line_number, original in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        keyword, values = fields[0], fields[1:]
        if keyword == "v":
            x, y, z = _finite_tuple(values, 3, "vertex", line_number)
            vertices.append((x, y, z))
        elif keyword == "vt":
            u, v = _finite_tuple(values, 2, "texture coordinate", line_number)
            uvs.append((u, v))
        elif keyword == "vn":
            x, y, z = _finite_tuple(values, 3, "normal", line_number)
            normal = (x, y, z)
            if _length(normal) <= 1e-12:
                raise ValueError(f"OBJ line {line_number}: normal must be non-zero")
            normals.append(_normalize(normal))
        elif keyword == "usemtl" and values:
            name = " ".join(values)
            active_material = material_slots.setdefault(name, len(material_slots))
        elif keyword == "f":
            if len(values) < 3:
                raise ValueError(f"OBJ line {line_number}: face needs at least three corners")
            corners: list[tuple[int, int | None, int | None]] = []
            for token in values:
                parts = token.split("/")
                vertex_index = _resolve_index(parts[0], len(vertices), "vertex", line_number)
                uv_index = None
                normal_index = None
                if len(parts) > 1 and parts[1]:
                    uv_index = _resolve_index(parts[1], len(uvs), "texture", line_number)
                if len(parts) > 2 and parts[2]:
                    normal_index = _resolve_index(parts[2], len(normals), "normal", line_number)
                corners.append((vertex_index, uv_index, normal_index))
            for fan_index in range(1, len(corners) - 1):
                selected = (corners[0], corners[fan_index], corners[fan_index + 1])
                position_tuple = tuple(vertices[corner[0]] for corner in selected)
                if len({_round_vec3(position) for position in position_tuple}) < 3:
                    warnings.append(f"OBJ line {line_number}: degenerate triangle skipped")
                    continue
                uv_tuple = None
                if all(corner[1] is not None for corner in selected):
                    uv_tuple = tuple(uvs[corner[1]] for corner in selected)  # type: ignore[index]
                elif require_uv:
                    raise ValueError(f"OBJ line {line_number}: every displacement triangle needs UV coordinates")
                normal_tuple = None
                if all(corner[2] is not None for corner in selected):
                    normal_tuple = tuple(normals[corner[2]] for corner in selected)  # type: ignore[index]
                triangles.append(
                    ObjTriangle(
                        positions=position_tuple,  # type: ignore[arg-type]
                        uvs=uv_tuple,  # type: ignore[arg-type]
                        normals=normal_tuple,  # type: ignore[arg-type]
                        material=active_material,
                        source_index=len(triangles),
                    )
                )

    if not vertices or not triangles:
        raise ValueError("OBJ must contain at least one non-degenerate triangle")
    if not material_slots:
        warnings.append("OBJ contains no material assignments; material slot 0 is used")
    return triangles, warnings


def _round_vec3(value: Vec3) -> tuple[float, float, float]:
    return tuple(round(component, 12) for component in value)  # type: ignore[return-value]


def triangle_box_overlap(triangle: tuple[Vec3, Vec3, Vec3], center: Vec3, half_size: float) -> bool:
    """Conservative Akenine-Möller-style triangle/AABB overlap test."""

    if half_size <= 0 or not math.isfinite(half_size):
        raise ValueError("box half-size must be positive and finite")
    vertices = tuple(_scale(_sub(vertex, center), 1.0 / half_size) for vertex in triangle)
    epsilon = 1e-10
    for axis in range(3):
        values = [vertex[axis] for vertex in vertices]
        if min(values) > 1.0 + epsilon or max(values) < -1.0 - epsilon:
            return False

    edges = (_sub(vertices[1], vertices[0]), _sub(vertices[2], vertices[1]), _sub(vertices[0], vertices[2]))
    basis = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    for edge in edges:
        for direction in basis:
            axis = _cross(edge, direction)
            if _dot(axis, axis) <= epsilon:
                continue
            projections = [_dot(vertex, axis) for vertex in vertices]
            radius = abs(axis[0]) + abs(axis[1]) + abs(axis[2])
            if min(projections) > radius + epsilon or max(projections) < -radius - epsilon:
                return False

    normal = _cross(edges[0], edges[1])
    if _dot(normal, normal) <= epsilon:
        return False
    distance = _dot(normal, vertices[0])
    radius = abs(normal[0]) + abs(normal[1]) + abs(normal[2])
    return abs(distance) <= radius + epsilon


def _closest_barycentric(point: Vec3, triangle: tuple[Vec3, Vec3, Vec3]) -> tuple[float, float, float]:
    """Return barycentric coordinates of the closest point on a triangle."""

    a, b, c = triangle
    ab = _sub(b, a)
    ac = _sub(c, a)
    ap = _sub(point, a)
    d1, d2 = _dot(ab, ap), _dot(ac, ap)
    if d1 <= 0 and d2 <= 0:
        return (1.0, 0.0, 0.0)
    bp = _sub(point, b)
    d3, d4 = _dot(ab, bp), _dot(ac, bp)
    if d3 >= 0 and d4 <= d3:
        return (0.0, 1.0, 0.0)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        denominator = d1 - d3 or 1.0
        value = d1 / denominator
        return (1.0 - value, value, 0.0)
    cp = _sub(point, c)
    d5, d6 = _dot(ab, cp), _dot(ac, cp)
    if d6 >= 0 and d5 <= d6:
        return (0.0, 0.0, 1.0)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        denominator = d2 - d6 or 1.0
        value = d2 / denominator
        return (1.0 - value, 0.0, value)
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        denominator = (d4 - d3) + (d5 - d6) or 1.0
        value = (d4 - d3) / denominator
        return (0.0, 1.0 - value, value)
    denominator = va + vb + vc or 1.0
    return (1.0 - (vb + vc) / denominator, vb / denominator, vc / denominator)


def _interpolate(values: tuple[Any, Any, Any], weights: tuple[float, float, float]) -> Any:
    return tuple(
        sum(float(values[index][axis]) * weights[index] for index in range(3))
        for axis in range(len(values[0]))
    )


def _sample_nearest(
    width: int,
    height: int,
    pixels: list[tuple[int, int, int, int]],
    uv: Vec2,
) -> tuple[int, int, int, int]:
    u = max(0.0, min(1.0, uv[0]))
    v = max(0.0, min(1.0, uv[1]))
    x = max(0, min(width - 1, math.floor(u * (width - 1) + 0.5)))
    y = max(0, min(height - 1, math.floor((1.0 - v) * (height - 1) + 0.5)))
    return pixels[y * width + x]


def _int8_step(value: int) -> int:
    return value if value < 128 else value - 256


def _normal_for_triangle(triangle: ObjTriangle) -> tuple[Vec3, Vec3, Vec3]:
    if triangle.normals:
        return triangle.normals
    normal = _face_normal(triangle.positions)
    return (normal, normal, normal)


def _chunk_coordinate(global_coordinate: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(value // CHUNK_EDGE for value in global_coordinate)  # type: ignore[return-value]


def _local_coordinate(global_coordinate: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(value % CHUNK_EDGE for value in global_coordinate)  # type: ignore[return-value]


def _canonical_normal(value: Vec3) -> Vec3:
    return tuple(round(component, 8) for component in _normalize(value))  # type: ignore[return-value]


def voxelize_obj(
    *,
    mesh_path: Path,
    height_path: Path | None = None,
    albedo_path: Path | None = None,
    voxel_size: float | None = None,
    longest_axis_voxels: int | None = 32,
    min_height_voxels: float = -1.0,
    max_height_voxels: float = 1.0,
    max_cells: int = MAX_VOXEL_CELLS,
    max_triangle_candidate_cells: int = MAX_TRIANGLE_CANDIDATE_CELLS,
) -> dict[str, Any]:
    """Voxelize a static OBJ into final occupied VXD logical chunks."""

    mesh_path = mesh_path.expanduser().resolve()
    if mesh_path.suffix.lower() != ".obj":
        raise ValueError("static surface voxelization currently accepts OBJ only; GLB buffer extraction is not implemented")
    if voxel_size is not None and (not math.isfinite(voxel_size) or voxel_size <= 0):
        raise ValueError("voxel size must be positive and finite")
    if voxel_size is None and (longest_axis_voxels is None or longest_axis_voxels < 1):
        raise ValueError("supply a positive voxel size or longest-axis resolution")
    if max_cells < 1 or max_triangle_candidate_cells < 1:
        raise ValueError("voxel candidate budgets must be positive")
    require_uv = height_path is not None or albedo_path is not None
    triangles, warnings = parse_obj_triangles(mesh_path, require_uv=require_uv)
    base_positions = [position for triangle in triangles for position in triangle.positions]
    base_minimum = [min(position[axis] for position in base_positions) for axis in range(3)]
    base_maximum = [max(position[axis] for position in base_positions) for axis in range(3)]
    base_extent = max(base_maximum[axis] - base_minimum[axis] for axis in range(3))
    if voxel_size is None:
        if base_extent <= 0:
            raise ValueError("mesh bounds are degenerate; cannot derive a voxel size")
        voxel_size = base_extent / float(longest_axis_voxels or 1)

    height_data: dict[str, Any] | None = None
    height_pixels: list[tuple[int, int, int, int]] | None = None
    albedo_data: dict[str, Any] | None = None
    albedo_pixels: list[tuple[int, int, int, int]] | None = None
    if height_path:
        height_width, height_height, height_pixels_value, height_warnings = load_image(height_path.expanduser().resolve())
        fields = height_fields(
            height_width,
            height_height,
            height_pixels_value,
            min_voxels=min_height_voxels,
            max_voxels=max_height_voxels,
        )
        if fields["statistics"]["nonOpaquePixelFraction"] > 0.0:
            raise ValueError("height texture contains non-opaque pixels; flatten it or declare an alpha policy")
        height_data = {"width": height_width, "height": height_height, "fields": fields}
        height_pixels = height_pixels_value
        warnings.extend(height_warnings)
    if albedo_path:
        albedo_width, albedo_height, albedo_pixels_value, albedo_warnings = load_image(albedo_path.expanduser().resolve())
        if height_data and (albedo_width, albedo_height) != (height_data["width"], height_data["height"]):
            raise ValueError("albedo and height textures must have identical dimensions; resample explicitly")
        if any(pixel[3] < 255 for pixel in albedo_pixels_value):
            raise ValueError("albedo texture contains non-opaque pixels; alpha-cutout occupancy is not implemented")
        albedo_data = {"width": albedo_width, "height": albedo_height}
        albedo_pixels = albedo_pixels_value
        warnings.extend(albedo_warnings)

    displaced_triangles: list[ObjTriangle] = []
    for triangle in triangles:
        normals = _normal_for_triangle(triangle)
        displaced_positions: list[Vec3] = []
        for index, position in enumerate(triangle.positions):
            step = 0
            if height_data and triangle.uvs:
                encoded_step = height_data["fields"]["heightStepsI8"][
                    _sample_pixel_index(height_data["width"], height_data["height"], triangle.uvs[index])
                ]
                step = _int8_step(encoded_step)
            displacement = _scale(normals[index], step * voxel_size)
            displaced_positions.append(_add(position, displacement))
        displaced_triangles.append(
            ObjTriangle(
                positions=tuple(displaced_positions),  # type: ignore[arg-type]
                uvs=triangle.uvs,
                normals=normals,
                material=triangle.material,
                source_index=triangle.source_index,
            )
        )

    all_positions = [position for triangle in displaced_triangles for position in triangle.positions]
    minimum = [min(position[axis] for position in all_positions) for axis in range(3)]
    maximum = [max(position[axis] for position in all_positions) for axis in range(3)]
    if not math.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError("derived voxel size must be positive and finite")
    origin = tuple(minimum[axis] - voxel_size for axis in range(3))
    dimensions = tuple(max(1, math.ceil((maximum[axis] - origin[axis]) / voxel_size) + 1) for axis in range(3))
    total_cells = dimensions[0] * dimensions[1] * dimensions[2]
    if total_cells > max_cells:
        raise ValueError(f"grid would contain {total_cells} cells, exceeding the {max_cells} cell budget")

    cells: dict[tuple[int, int, int], VoxelCell] = {}
    for triangle in displaced_triangles:
        triangle_min = [min(vertex[axis] for vertex in triangle.positions) for axis in range(3)]
        triangle_max = [max(vertex[axis] for vertex in triangle.positions) for axis in range(3)]
        ranges = []
        for axis in range(3):
            start = max(0, math.floor((triangle_min[axis] - origin[axis]) / voxel_size))
            end = min(dimensions[axis] - 1, math.floor((triangle_max[axis] - origin[axis]) / voxel_size))
            ranges.append((start, end))
        candidate_count = max(0, ranges[0][1] - ranges[0][0] + 1) * max(0, ranges[1][1] - ranges[1][0] + 1) * max(0, ranges[2][1] - ranges[2][0] + 1)
        if candidate_count > max_triangle_candidate_cells:
            raise ValueError(
                f"triangle {triangle.source_index} touches {candidate_count} candidate cells, "
                f"exceeding the {max_triangle_candidate_cells} cell budget"
            )
        face_normal = _face_normal(triangle.positions)
        for z in range(ranges[2][0], ranges[2][1] + 1):
            for y in range(ranges[1][0], ranges[1][1] + 1):
                for x in range(ranges[0][0], ranges[0][1] + 1):
                    center = (
                        origin[0] + (x + 0.5) * voxel_size,
                        origin[1] + (y + 0.5) * voxel_size,
                        origin[2] + (z + 0.5) * voxel_size,
                    )
                    if not triangle_box_overlap(triangle.positions, center, voxel_size * 0.5):
                        continue
                    global_coordinate = (x, y, z)
                    if global_coordinate in cells:
                        continue
                    barycentric = _closest_barycentric(center, triangle.positions)
                    uv = _interpolate(triangle.uvs, barycentric) if triangle.uvs else (0.0, 0.0)
                    normal = _interpolate(triangle.normals, barycentric) if triangle.normals else face_normal
                    albedo = (
                        _sample_nearest(albedo_data["width"], albedo_data["height"], albedo_pixels or [], uv)
                        if albedo_data
                        else (190, 190, 190, 255)
                    )
                    cells[global_coordinate] = VoxelCell(
                        coordinate=global_coordinate,
                        albedo=tuple(int(channel) for channel in albedo),  # type: ignore[arg-type]
                        normal=_canonical_normal(normal),
                        material=triangle.material,
                    )

    if not cells:
        raise ValueError("voxelization produced no occupied cells; increase resolution or inspect mesh bounds")
    chunks_by_coordinate: dict[tuple[int, int, int], list[VoxelCell]] = {}
    for cell in sorted(cells.values(), key=lambda item: item.coordinate):
        chunk_coordinate = _chunk_coordinate(cell.coordinate)
        local = _local_coordinate(cell.coordinate)
        chunks_by_coordinate.setdefault(chunk_coordinate, []).append(
            VoxelCell(
                coordinate=local,
                albedo=cell.albedo,
                normal=cell.normal,
                material=cell.material,
                flags=cell.flags,
            )
        )
    chunks = [
        {
            "coordinate": list(chunk_coordinate),
            "cells": [
                {
                    "coordinate": list(cell.coordinate),
                    "attributes": {
                        "albedo": list(cell.albedo),
                        "normal": list(cell.normal),
                        "material": cell.material,
                        "flags": cell.flags,
                    },
                }
                for cell in sorted(chunk_cells, key=lambda item: item.coordinate)
            ],
        }
        for chunk_coordinate, chunk_cells in sorted(chunks_by_coordinate.items(), key=lambda item: (item[0][2], item[0][1], item[0][0]))
    ]

    height_source = None
    if height_path:
        resolved = height_path.expanduser().resolve()
        height_source = {"path": str(resolved), "sha256": sha256_file(resolved), "bytes": resolved.stat().st_size}
    albedo_source = None
    if albedo_path:
        resolved = albedo_path.expanduser().resolve()
        albedo_source = {"path": str(resolved), "sha256": sha256_file(resolved), "bytes": resolved.stat().st_size}
    grid = {
        "origin": [round(value, 8) for value in origin],
        "dimensions": list(dimensions),
        "voxelSize": round(voxel_size, 8),
        "chunkEdge": CHUNK_EDGE,
        "coordinateSystem": "right-handed-y-up",
        "cellOrder": "x-fastest-then-y-then-z",
    }
    vxd = {
        "kind": "voxel-displacement-data",
        "version": 1,
        "grid": {
            "chunkEdge": CHUNK_EDGE,
            "cellSize": round(voxel_size, 8),
            "origin": grid["origin"],
            "coordinateSystem": grid["coordinateSystem"],
            "cellOrder": grid["cellOrder"],
        },
        "attributes": {
            "albedo": "rgba8-srgb",
            "normal": "octahedral-unorm8x2",
            "material": "uint8",
            "flags": "uint8",
        },
        "chunks": chunks,
    }
    return {
        "schema": VOXEL_OBJECT_SCHEMA,
        "kind": "voxel-object-bake",
        "profile": "voxel-displacement-inspired",
        "representation": "surface-voxel-mesh",
        "sources": {
            "mesh": {"path": str(mesh_path), "sha256": sha256_file(mesh_path), "bytes": mesh_path.stat().st_size},
            "height": height_source,
            "albedo": albedo_source,
        },
        "grid": grid,
        "recipe": {
            "occupancy": "conservative-triangle-box-overlap",
            "voxelSizeAuthority": "explicit" if voxel_size is not None else "longest-axis-derived",
            "longestAxisVoxels": longest_axis_voxels if voxel_size is None else None,
            "heightSampling": "nearest-clamp-v-flipped",
            "heightChannel": "raw-rgb-data-bt709-luma-u8",
            "heightDisplacement": "vertex-normal-whole-voxel-steps-before-occupancy",
            "heightVoxelRange": [round(min_height_voxels, 8), round(max_height_voxels, 8)] if height_data else None,
            "attributeSampling": "closest-triangle-point-first-source-triangle-wins",
            "normalEncoding": "unit-object-local-vector; VXD codec quantizes to octahedral-unorm8x2",
            "albedoColorSpace": "srgb",
        },
        "statistics": {
            "triangleCount": len(displaced_triangles),
            "occupiedCellCount": len(cells),
            "chunkCount": len(chunks),
            "gridCellCount": total_cells,
        },
        "vxd": vxd,
        "warnings": sorted(set(warnings)),
        "unimplemented": [
            "GLB mesh-buffer extraction and skin/morph pose materialization",
            "continuous per-cell height interpolation beyond vertex displacement",
            "multi-chunk binary container emission",
            "WebGPU traversal and browser GPU upload",
        ],
        "honesty": "CPU reference voxelization only; conservative occupancy is independent of Schroeder's unpublished preprocessing.",
    }


def _sample_pixel_index(width: int, height: int, uv: Vec2) -> int:
    u = max(0.0, min(1.0, uv[0]))
    v = max(0.0, min(1.0, uv[1]))
    x = max(0, min(width - 1, math.floor(u * (width - 1) + 0.5)))
    y = max(0, min(height - 1, math.floor((1.0 - v) * (height - 1) + 0.5)))
    return y * width + x
