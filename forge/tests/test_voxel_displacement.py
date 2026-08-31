#!/usr/bin/env python3
"""Focused contracts for the voxel-displacement intake and texture bake."""

from __future__ import annotations

import base64
import copy
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

from forge._shared.voxel_displacement import (
    BAKE_SCHEMA,
    build_reference_brief,
    decode_channel,
    height_fields,
)
from forge._shared.voxel_mesh import triangle_box_overlap, voxelize_obj
from forge.stage1_intake.plan_voxel_displacement import build_plan, probe_obj
from forge.stage1_intake.probe_glb import parse_glb
from forge.stage3_build.bake_voxel_displacement import bake, validate_bake
from forge.stage3_build.generate_low_poly_tree_obj import build_tree
from forge.tests.test_glb_reference import write_triangle_glb


ROOT = Path(__file__).resolve().parents[2]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def write_png(path: Path, width: int, height: int, pixel) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind)
        checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        PNG_SIGNATURE
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def write_plane_obj(path: Path, *, with_uv: bool = True) -> None:
    lines = [
        "o Plane",
        "v 0 0 0",
        "v 1 0 0",
        "v 1 1 0",
        "v 0 1 0",
    ]
    if with_uv:
        lines.extend(("vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1"))
    lines.append("vn 0 0 1")
    if with_uv:
        lines.append("f 1/1/1 2/2/1 3/3/1 4/4/1")
    else:
        lines.append("f 1//1 2//1 3//1 4//1")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def mutate_glb(path: Path, mutator) -> None:
    document, binary_payload, _binary = parse_glb(path)
    mutator(document)
    json_chunk = json.dumps(document, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary_chunk = binary_payload + b"\x00" * ((4 - len(binary_payload) % 4) % 4)
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<II", len(json_chunk), 0x4E4F534A)
        + json_chunk
        + struct.pack("<II", len(binary_chunk), 0x004E4942)
        + binary_chunk
    )


class HeightFieldContracts(unittest.TestCase):
    def test_whole_voxel_steps_and_continuous_normals_are_separate(self) -> None:
        pixels = [(0, 0, 0, 255), (128, 128, 128, 255), (255, 255, 255, 255)]
        result = height_fields(3, 1, pixels, min_voxels=-2, max_voxels=2)

        self.assertEqual(list(result["heightUnorm8"]), [0, 128, 255])
        self.assertEqual([value if value < 128 else value - 256 for value in result["heightStepsI8"]], [-2, 0, 2])
        self.assertEqual(len(result["surfaceNormalOct8"]), 6)
        self.assertEqual(result["mapping"]["quantization"], "nearest-whole-voxel")
        self.assertEqual(result["mapping"]["roundingTies"], "to-even")

    def test_channel_encoding_round_trips_and_detects_tampering(self) -> None:
        from forge._shared.voxel_displacement import encode_channel

        encoded = encode_channel(bytes(range(64)))
        self.assertEqual(decode_channel(encoded), bytes(range(64)))
        tampered = copy.deepcopy(encoded)
        tampered["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash"):
            decode_channel(tampered)

    def test_channel_decoder_bounds_decompression_and_rejects_trailing_streams(self) -> None:
        from forge._shared.voxel_displacement import encode_channel

        encoded = encode_channel(b"a" * 1024)
        with self.assertRaisesRegex(ValueError, "allowed size"):
            decode_channel(encoded, max_decoded_bytes=128)

        trailing = copy.deepcopy(encoded)
        compressed = zlib.compress(b"a" * 1024) + zlib.compress(b"extra")
        trailing["data"] = base64.b64encode(compressed).decode("ascii")
        trailing["encodedBytes"] = len(compressed)
        with self.assertRaisesRegex(ValueError, "trailing"):
            decode_channel(trailing)

    def test_zero_source_value_is_null_when_range_never_crosses_zero(self) -> None:
        result = height_fields(1, 1, [(128, 128, 128, 255)], min_voxels=2, max_voxels=4)

        self.assertIsNone(result["mapping"]["zeroSourceValue"])
        self.assertEqual(result["mapping"]["sourceInterpretation"], "raw-rgb-data-bt709-luma-u8")


class ReferenceBriefContracts(unittest.TestCase):
    def test_object_prompt_builds_one_template_locked_sprite_sheet(self) -> None:
        brief = build_reference_brief("a brass clockwork beetle", subject_kind="object")

        self.assertEqual(brief["requestedModel"], "gpt-image-2")
        self.assertEqual(brief["executionMode"], "built-in-tool")
        self.assertEqual(brief["strategy"], "single-template-sprite-sheet")
        self.assertEqual([step["id"] for step in brief["workflow"]], ["sprite-sheet"])
        self.assertEqual(brief["workflow"][0]["toolInvocation"], "$imagegen")
        self.assertEqual(brief["workflow"][0]["template"]["width"], 128)
        self.assertIn("one 128x128 square sprite sheet", brief["workflow"][0]["prompt"])
        self.assertIn("exact five-panel composition", brief["workflow"][0]["prompt"])
        self.assertEqual(brief["viewContract"]["constructionViews"][-1]["id"], "top")
        self.assertEqual(brief["viewContract"]["constructionViews"][1]["azimuthDegrees"], 90)

    def test_empty_prompt_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            build_reference_brief("  \n ")

    def test_material_prompt_builds_albedo_height_and_review_outputs(self) -> None:
        brief = build_reference_brief("worn sandstone blocks", subject_kind="material")

        self.assertEqual(
            [step["id"] for step in brief["workflow"]],
            ["anchor", "height-candidate", "material-oblique"],
        )
        self.assertNotIn("transparent background", brief["workflow"][0]["prompt"])
        self.assertIn("height-map candidate", brief["workflow"][1]["prompt"])
        self.assertTrue(any("estimate" in item for item in brief["acceptance"]["required"]))


class LowPolyTreeFixtureContracts(unittest.TestCase):
    def test_dark_fantasy_tree_fixture_is_deterministic_and_has_no_duplicate_corners(self) -> None:
        first = build_tree()
        second = build_tree()

        self.assertEqual(first.vertices, second.vertices)
        self.assertEqual(first.faces, second.faces)
        self.assertEqual({material for material, _corners in first.faces}, {"bark", "leaf", "moss", "rune"})
        self.assertGreater(len(first.faces), 500)
        self.assertTrue(all(len({corner[0] for corner in corners}) == len(corners) for _material, corners in first.faces))


class IntakeRoutingContracts(unittest.TestCase):
    def test_uv_mapped_obj_plus_height_is_ready_for_surface_displacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            write_plane_obj(mesh)
            write_png(height, 4, 4, lambda x, y: (x * 60, x * 60, x * 60, 255))

            plan = build_plan(
                name="wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
            )

        self.assertEqual(plan["route"], "surface-displacement")
        self.assertEqual(plan["status"], "ready-to-bake")
        self.assertEqual(plan["inputs"]["mesh"]["attributes"]["uvCornerFraction"], 1.0)
        self.assertIn("collision", " ".join(plan["nextActions"]))

    def test_missing_uv_blocks_surface_displacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            write_plane_obj(mesh, with_uv=False)
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            plan = build_plan(
                name="bad-wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
            )

        self.assertEqual(plan["status"], "blocked")
        self.assertTrue(any("UV" in finding for finding in plan["findings"]))

    def test_mismatched_albedo_and_height_dimensions_block_the_plan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            albedo = root / "albedo.png"
            write_plane_obj(mesh)
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            write_png(albedo, 4, 4, lambda x, y: (40, 60, 80, 255))
            plan = build_plan(
                name="mismatched-wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
                albedo_path=albedo,
            )

        self.assertEqual(plan["status"], "blocked")
        self.assertTrue(any("dimensions differ" in finding for finding in plan["findings"]))

    def test_prompt_only_routes_to_codex_imagegen(self) -> None:
        plan = build_plan(
            name="beetle",
            asset_role="prop",
            prompt="a brass clockwork beetle",
        )

        self.assertEqual(plan["route"], "generated-reference-intake")
        self.assertEqual(plan["status"], "needs-image-generation")
        self.assertEqual(plan["referenceGeneration"]["subjectKind"], "object")

    def test_obj_probe_reports_open_topology_without_rejecting_a_surface(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plane.obj"
            write_plane_obj(path)
            result = probe_obj(path)

        self.assertEqual(result["triangleCount"], 2)
        self.assertEqual(result["topology"]["boundaryEdgeCount"], 4)
        self.assertFalse(result["topology"]["watertightCandidate"])

    def test_obj_probe_rejects_malformed_uv_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad-uv.obj"
            path.write_text(
                "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt nope nan\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "texture coordinate"):
                probe_obj(path)

    def test_static_glb_without_height_routes_to_surface_voxel_mesh(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mesh = Path(directory) / "triangle.glb"
            write_triangle_glb(mesh)
            plan = build_plan(name="triangle", asset_role="prop", mesh_path=mesh)

        self.assertEqual(plan["route"], "surface-voxel-mesh")
        self.assertEqual(plan["status"], "planned")
        self.assertEqual(plan["inputs"]["mesh"]["kind"], "glb")

    def test_glb_rigid_animation_stays_distinct_from_deformation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mesh = Path(directory) / "rigid.glb"
            write_triangle_glb(mesh)
            mutate_glb(mesh, lambda document: document.update({"animations": [{"channels": [], "samplers": []}]}))

            plan = build_plan(name="rigid", asset_role="prop", mesh_path=mesh)

        self.assertEqual(plan["route"], "surface-voxel-mesh")
        self.assertTrue(plan["inputs"]["mesh"]["rigidAnimated"])
        self.assertFalse(plan["inputs"]["mesh"]["deforming"])

    def test_glb_skin_or_morph_target_routes_to_baked_frames(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skinned = root / "skinned.glb"
            write_triangle_glb(skinned)

            def add_skin(document) -> None:
                document["skins"] = [{"joints": [0]}]
                document["nodes"][0]["skin"] = 0

            mutate_glb(skinned, add_skin)
            skin_plan = build_plan(name="skinned", asset_role="character", mesh_path=skinned)

            morphed = root / "morphed.glb"
            write_triangle_glb(morphed)
            mutate_glb(
                morphed,
                lambda document: document["meshes"][0]["primitives"][0].update({"targets": [{"POSITION": 0}]}),
            )
            morph_plan = build_plan(name="morphed", asset_role="character", mesh_path=morphed)

        self.assertEqual(skin_plan["route"], "baked-surface-voxel-frames")
        self.assertTrue(skin_plan["inputs"]["mesh"]["deforming"])
        self.assertEqual(morph_plan["route"], "baked-surface-voxel-frames")
        self.assertTrue(morph_plan["inputs"]["mesh"]["animation"]["hasMorphTargets"])

    def test_glb_non_triangle_primitives_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mesh = Path(directory) / "lines.glb"
            write_triangle_glb(mesh)
            mutate_glb(mesh, lambda document: document["meshes"][0]["primitives"][0].update({"mode": 1}))

            plan = build_plan(name="lines", asset_role="prop", mesh_path=mesh)

        self.assertEqual(plan["status"], "blocked")
        self.assertTrue(any("triangle primitives" in finding for finding in plan["findings"]))

    def test_non_opaque_height_requires_an_explicit_alpha_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            height = Path(directory) / "transparent-height.png"
            write_png(height, 2, 2, lambda x, y: (255, 255, 255, 0 if x == 0 else 255))

            plan = build_plan(name="masked", asset_role="material", height_path=height)

            self.assertEqual(plan["status"], "blocked")
            with self.assertRaisesRegex(ValueError, "non-opaque"):
                bake(height_path=height)


class BakeContracts(unittest.TestCase):
    def test_bake_is_deterministic_and_round_trips_every_channel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            height = root / "height.png"
            albedo = root / "albedo.png"
            write_png(height, 8, 4, lambda x, y: (x * 32, x * 32, x * 32, 255))
            write_png(albedo, 8, 4, lambda x, y: (x * 20, y * 40, 80, 255))

            first = bake(height_path=height, albedo_path=albedo, min_height_voxels=-3, max_height_voxels=3)
            second = bake(height_path=height, albedo_path=albedo, min_height_voxels=-3, max_height_voxels=3)

        self.assertEqual(first, second)
        self.assertEqual(first["schema"], BAKE_SCHEMA)
        self.assertEqual(validate_bake(first), [])
        self.assertEqual(
            first["channels"]["surfaceNormalOct8"]["semantic"],
            "octahedral-texture-space-normal-provisional",
        )
        self.assertEqual(len(decode_channel(first["channels"]["heightUnorm8"])), 32)
        self.assertEqual(len(decode_channel(first["channels"]["heightStepsI8"])), 32)
        self.assertEqual(len(decode_channel(first["channels"]["surfaceNormalOct8"])), 64)
        self.assertEqual(len(decode_channel(first["channels"]["albedoRgba8"])), 128)

    def test_bake_refuses_implicit_texture_resampling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            height = root / "height.png"
            albedo = root / "albedo.png"
            write_png(height, 4, 4, lambda x, y: (128, 128, 128, 255))
            write_png(albedo, 8, 8, lambda x, y: (20, 40, 80, 255))
            with self.assertRaisesRegex(ValueError, "resample explicitly"):
                bake(height_path=height, albedo_path=albedo)

    def test_validator_rejects_corrupted_channel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            height = Path(directory) / "height.png"
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            artifact = bake(height_path=height)
        artifact["channels"]["heightUnorm8"]["sha256"] = "f" * 64

        errors = validate_bake(artifact)

        self.assertTrue(any("hash" in error for error in errors), errors)

    def test_validator_rejects_contract_metadata_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            height = Path(directory) / "height.png"
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            artifact = bake(height_path=height)
        artifact["dimensions"]["texelCount"] = 999
        artifact["channels"]["surfaceNormalOct8"]["semantic"] = "world-normal"
        artifact["mapping"]["voxelRange"] = [-1000, 1000]

        errors = validate_bake(artifact)

        self.assertTrue(any("texelCount" in error for error in errors), errors)
        self.assertTrue(any("semantic" in error for error in errors), errors)
        self.assertTrue(any("-127..127" in error for error in errors), errors)

    def test_bake_rejects_source_drift_after_planning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            write_plane_obj(mesh)
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            plan = build_plan(
                name="wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
            )

            write_png(height, 2, 2, lambda x, y: (64, 64, 64, 255))
            with self.assertRaisesRegex(ValueError, "height source hash changed"):
                bake(height_path=height, plan=plan)

            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))
            plan = build_plan(
                name="wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
            )
            mesh.write_text(mesh.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "mesh source hash changed"):
                bake(height_path=height, plan=plan)

    def test_cli_writes_an_atomic_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            height = root / "height.png"
            output = root / "bake.json"
            write_png(height, 2, 2, lambda x, y: (x * 255, x * 255, x * 255, 255))
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "stage3_build" / "bake_voxel_displacement.py"),
                    "--height",
                    str(height),
                    "--out",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["schema"], BAKE_SCHEMA)
            self.assertFalse(output.with_suffix(".json.tmp").exists())


class SurfaceVoxelizationContracts(unittest.TestCase):
    def test_triangle_box_overlap_is_conservative_and_rejects_separated_cells(self) -> None:
        triangle = ((-0.4, -0.4, 0.0), (0.4, -0.4, 0.0), (0.0, 0.4, 0.0))

        self.assertTrue(triangle_box_overlap(triangle, (0.0, 0.0, 0.0), 0.5))
        self.assertFalse(triangle_box_overlap(triangle, (0.0, 0.0, 2.0), 0.5))

    def test_obj_voxelization_emits_final_cells_and_samples_height_and_albedo(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            albedo = root / "albedo.png"
            write_plane_obj(mesh)
            write_png(height, 4, 4, lambda x, y: (255, 255, 255, 255))
            write_png(albedo, 4, 4, lambda x, y: (220, 40, 20, 255))

            first = voxelize_obj(
                mesh_path=mesh,
                height_path=height,
                albedo_path=albedo,
                longest_axis_voxels=8,
                min_height_voxels=0,
                max_height_voxels=2,
            )
            second = voxelize_obj(
                mesh_path=mesh,
                height_path=height,
                albedo_path=albedo,
                longest_axis_voxels=8,
                min_height_voxels=0,
                max_height_voxels=2,
            )

        self.assertEqual(first, second)
        self.assertEqual(first["representation"], "surface-voxel-mesh")
        self.assertEqual(first["statistics"]["occupiedCellCount"], sum(len(chunk["cells"]) for chunk in first["vxd"]["chunks"]))
        self.assertGreater(first["statistics"]["occupiedCellCount"], 0)
        cell = first["vxd"]["chunks"][0]["cells"][0]
        self.assertEqual(cell["attributes"]["albedo"], [220, 40, 20, 255])
        self.assertEqual(cell["attributes"]["flags"], 0)
        self.assertEqual(first["recipe"]["heightDisplacement"], "vertex-normal-whole-voxel-steps-before-occupancy")

    def test_texture_conversion_requires_uvs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            write_plane_obj(mesh, with_uv=False)
            write_png(height, 2, 2, lambda x, y: (128, 128, 128, 255))

            with self.assertRaisesRegex(ValueError, "needs UV"):
                voxelize_obj(mesh_path=mesh, height_path=height, longest_axis_voxels=8)

    def test_static_converter_rejects_glb_until_buffer_extraction_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            mesh = Path(directory) / "triangle.glb"
            write_triangle_glb(mesh)

            with self.assertRaisesRegex(ValueError, "accepts OBJ only"):
                voxelize_obj(mesh_path=mesh, longest_axis_voxels=8)

    def test_cli_honors_plan_height_range_and_emits_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            height = root / "height.png"
            plan_path = root / "intake.json"
            output = root / "object.json"
            write_plane_obj(mesh)
            write_png(height, 2, 2, lambda x, y: (255, 255, 255, 255))
            plan = build_plan(
                name="ranged-wall",
                asset_role="environment",
                mesh_path=mesh,
                height_path=height,
                min_height_voxels=0,
                max_height_voxels=2,
            )
            plan_path.write_text(json.dumps(plan), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "forge" / "stage3_build" / "voxelize_obj.py"),
                    "--plan",
                    str(plan_path),
                    "--longest-axis-voxels",
                    "8",
                    "--out",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            artifact = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(artifact["recipe"]["heightVoxelRange"], [0, 2])
            self.assertEqual(artifact["sources"]["mesh"]["sha256"], plan["inputs"]["mesh"]["sha256"])

    def test_albedo_alpha_is_blocked_until_cutout_occupancy_is_defined(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mesh = root / "plane.obj"
            albedo = root / "masked.png"
            write_plane_obj(mesh)
            write_png(albedo, 2, 2, lambda x, y: (220, 40, 20, 0 if x == 0 else 255))

            with self.assertRaisesRegex(ValueError, "alpha-cutout occupancy"):
                voxelize_obj(mesh_path=mesh, albedo_path=albedo, longest_axis_voxels=8)


if __name__ == "__main__":
    unittest.main(verbosity=2)
