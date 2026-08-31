"""Shared, renderer-neutral voxel-displacement helpers.

The displacement renderer itself is intentionally not implemented here.  This
module turns ordinary image pixels into the two fields a renderer needs:

* whole-voxel height steps for visible geometry; and
* continuous-height normals for sub-voxel lighting detail.

It also builds the Codex ImageGen brief used when intake starts from text.
Everything in this module is deterministic and Python 3.10+ stdlib-only.
"""

from __future__ import annotations

import base64
import hashlib
import math
import zlib
from pathlib import Path
from typing import Any, Iterable


BAKE_SCHEMA = "img2threejs.voxel-displacement-bake.v1"
INTAKE_SCHEMA = "img2threejs.voxel-displacement-intake.v1"
REFERENCE_BRIEF_SCHEMA = "img2threejs.voxel-reference-brief.v1"
MAX_CHANNEL_DECODED_BYTES = 512 * 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encode_channel(payload: bytes) -> dict[str, Any]:
    """Encode a binary channel in a portable JSON representation."""

    compressed = zlib.compress(payload, level=9)
    return {
        "encoding": "zlib-base64",
        "decodedBytes": len(payload),
        "encodedBytes": len(compressed),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "data": base64.b64encode(compressed).decode("ascii"),
    }


def decode_channel(channel: dict[str, Any], *, max_decoded_bytes: int | None = None) -> bytes:
    if channel.get("encoding") != "zlib-base64":
        raise ValueError("unsupported voxel-displacement channel encoding")
    decoded_bytes = channel.get("decodedBytes")
    encoded_bytes = channel.get("encodedBytes")
    if not isinstance(decoded_bytes, int) or isinstance(decoded_bytes, bool) or decoded_bytes < 0:
        raise ValueError("voxel-displacement channel decodedBytes must be a non-negative integer")
    if not isinstance(encoded_bytes, int) or isinstance(encoded_bytes, bool) or encoded_bytes < 0:
        raise ValueError("voxel-displacement channel encodedBytes must be a non-negative integer")
    effective_limit = MAX_CHANNEL_DECODED_BYTES
    if max_decoded_bytes is not None:
        if max_decoded_bytes < 0:
            raise ValueError("maximum decoded channel size must be non-negative")
        effective_limit = min(effective_limit, max_decoded_bytes)
    if decoded_bytes > effective_limit:
        raise ValueError("declared voxel-displacement channel length exceeds the allowed size")
    try:
        compressed = base64.b64decode(str(channel["data"]), validate=True)
    except Exception as exc:  # noqa: BLE001 - convert codec errors into a stable contract error
        raise ValueError(f"invalid voxel-displacement channel: {exc}") from exc
    if len(compressed) != encoded_bytes:
        raise ValueError("encoded voxel-displacement channel length does not match metadata")
    try:
        decompressor = zlib.decompressobj()
        payload = decompressor.decompress(compressed, decoded_bytes + 1)
    except zlib.error as exc:
        raise ValueError(f"invalid voxel-displacement channel: {exc}") from exc
    if len(payload) > decoded_bytes or decompressor.unconsumed_tail or not decompressor.eof:
        raise ValueError("decoded voxel-displacement channel exceeds or does not reach its declared length")
    if decompressor.unused_data:
        raise ValueError("voxel-displacement channel contains trailing compressed data")
    if len(payload) != decoded_bytes:
        raise ValueError("decoded voxel-displacement channel length does not match metadata")
    if hashlib.sha256(payload).hexdigest() != channel.get("sha256"):
        raise ValueError("decoded voxel-displacement channel hash does not match metadata")
    return payload


def _height_sample_byte(pixel: tuple[int, int, int, int]) -> int:
    """Collapse raw RGB data bytes to one height sample.

    The intake decoder does not expose image color-profile intent, so this is
    deliberately an encoded-value BT.709 luma calculation rather than a claim
    that an sRGB transfer function was removed. Grayscale height maps pass
    through unchanged.
    """

    red, green, blue, _alpha = pixel
    return max(0, min(255, round(0.2126 * red + 0.7152 * green + 0.0722 * blue)))


def _validate_height_range(min_voxels: float, max_voxels: float) -> None:
    if not math.isfinite(min_voxels) or not math.isfinite(max_voxels):
        raise ValueError("voxel height range must be finite")
    if min_voxels >= max_voxels:
        raise ValueError("minimum voxel height must be less than maximum voxel height")
    if min_voxels < -127 or max_voxels > 127:
        raise ValueError("voxel height range must fit signed 8-bit steps (-127..127)")


def height_fields(
    width: int,
    height: int,
    pixels: Iterable[tuple[int, int, int, int]],
    *,
    min_voxels: float,
    max_voxels: float,
    normal_strength: float = 1.0,
) -> dict[str, Any]:
    """Build continuous height, whole-step displacement and octahedral normals."""

    _validate_height_range(min_voxels, max_voxels)
    if width <= 0 or height <= 0:
        raise ValueError("height image dimensions must be positive")
    if not math.isfinite(normal_strength) or normal_strength <= 0:
        raise ValueError("normal strength must be a positive finite number")

    pixel_list = list(pixels)
    if len(pixel_list) != width * height:
        raise ValueError("height pixel count does not match image dimensions")

    continuous = bytes(_height_sample_byte(pixel) for pixel in pixel_list)
    steps_signed: list[int] = []
    for value in continuous:
        height_voxels = min_voxels + (value / 255.0) * (max_voxels - min_voxels)
        steps_signed.append(max(-127, min(127, round(height_voxels))))
    steps = bytes(step & 0xFF for step in steps_signed)

    oct_normals = bytearray()
    height_scale = max_voxels - min_voxels
    for y in range(height):
        top_y = max(0, y - 1)
        bottom_y = min(height - 1, y + 1)
        for x in range(width):
            left_x = max(0, x - 1)
            right_x = min(width - 1, x + 1)
            left = continuous[y * width + left_x] / 255.0
            right = continuous[y * width + right_x] / 255.0
            top = continuous[top_y * width + x] / 255.0
            bottom = continuous[bottom_y * width + x] / 255.0
            dx = (right - left) * height_scale * normal_strength
            dy = (bottom - top) * height_scale * normal_strength
            nx, ny, nz = -dx, -dy, 2.0
            length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            nx, ny, nz = nx / length, ny / length, nz / length
            denominator = abs(nx) + abs(ny) + abs(nz) or 1.0
            ox, oy = nx / denominator, ny / denominator
            if nz < 0:
                old_x = ox
                ox = (1.0 - abs(oy)) * (1.0 if old_x >= 0 else -1.0)
                oy = (1.0 - abs(old_x)) * (1.0 if oy >= 0 else -1.0)
            oct_normals.extend(
                (
                    max(0, min(255, round((ox * 0.5 + 0.5) * 255.0))),
                    max(0, min(255, round((oy * 0.5 + 0.5) * 255.0))),
                )
            )

    chromatic_pixels = sum(
        1 for red, green, blue, _alpha in pixel_list if max(red, green, blue) - min(red, green, blue) > 8
    )
    opaque_pixels = sum(1 for _red, _green, _blue, alpha in pixel_list if alpha == 255)
    transparent_pixels = sum(1 for _red, _green, _blue, alpha in pixel_list if alpha < 255)
    unique_steps = sorted(set(steps_signed))
    zero_source_value = None
    if min_voxels <= 0.0 <= max_voxels:
        zero_source_value = round((0.0 - min_voxels) / (max_voxels - min_voxels) * 255.0, 3)
    return {
        "mapping": {
            "sourceRange": [0, 255],
            "voxelRange": [min_voxels, max_voxels],
            "quantization": "nearest-whole-voxel",
            "roundingTies": "to-even",
            "sourceInterpretation": "raw-rgb-data-bt709-luma-u8",
            "zeroSourceValue": zero_source_value,
        },
        "statistics": {
            "minSourceValue": min(continuous),
            "maxSourceValue": max(continuous),
            "meanSourceValue": round(sum(continuous) / len(continuous), 3),
            "quantizedSteps": unique_steps,
            "chromaticPixelFraction": round(chromatic_pixels / len(pixel_list), 6),
            "opaquePixelFraction": round(opaque_pixels / len(pixel_list), 6),
            "nonOpaquePixelFraction": round(transparent_pixels / len(pixel_list), 6),
        },
        "heightUnorm8": continuous,
        "heightStepsI8": steps,
        "surfaceNormalOct8": bytes(oct_normals),
    }


def build_reference_brief(prompt: str, *, subject_kind: str = "object") -> dict[str, Any]:
    """Build a Codex ImageGen brief for reconstruction references.

    The built-in tool is intentionally invoked by the agent, not by deterministic
    forge code. Material references use several map/review outputs. Object,
    environment, and character references use one template-driven 128x128
    pixel-art construction sheet so the input is a sprite layout rather than a
    cinematic render.
    """

    normalized = " ".join(prompt.split())
    if not normalized:
        raise ValueError("text prompt must not be empty")
    if subject_kind not in {"object", "character", "environment", "material"}:
        raise ValueError("subject kind must be object, character, environment, or material")

    construction_views: list[dict[str, Any]] = []

    if subject_kind == "material":
        anchor_request = (
            f"Create an opaque, seamless square albedo reference for: {normalized}. "
            "Fill the frame with one orthographic tile under flat neutral illumination, with no baked highlights or shadows."
        )
        derived = [
            {
                "id": "height-candidate",
                "operation": "generate-with-reference",
                "reference": "anchor",
                "request": (
                    "Using exactly the same tile layout, create a seamless grayscale height-map candidate. "
                    "White means higher, black means lower, and there must be no lighting or color."
                ),
            },
            {
                "id": "material-oblique",
                "operation": "generate-with-reference",
                "reference": "anchor",
                "request": (
                    "Render a physical oblique preview of the exact same tile under raking light so relief can be reviewed."
                ),
            }
        ]
        shared_constraints = (
            "Keep the motif, scale, colors, tile boundaries, and edge continuity identical across outputs. "
            "No objects, perspective in data maps, text, labels, border, watermark, logo, or non-seamless edge."
        )
        composition = "square orthographic tile; pattern reaches every edge; opposite edges tile seamlessly"
        acceptance_required = [
            "all files are readable square raster images",
            "the albedo candidate is opaque and seamless with no directional lighting baked in",
            "the height candidate preserves the anchor layout and uses grayscale data only",
            "opposite edges remain continuous in both data-map candidates",
            "the oblique preview depicts the same material and is used only for visual review",
            "generated height is treated as an estimate and calibrated before metric displacement",
            "no labels, borders, watermarks, logos, or unrelated objects",
        ]
    else:
        construction_views = [
            {
                "id": "front",
                "view": "front orthographic",
                "azimuthDegrees": 0,
                "elevationDegrees": 0,
            },
            {
                "id": "right",
                "view": "right orthographic",
                "azimuthDegrees": 90,
                "elevationDegrees": 0,
            },
            {
                "id": "back",
                "view": "back orthographic",
                "azimuthDegrees": 180,
                "elevationDegrees": 0,
            },
            {
                "id": "left",
                "view": "left orthographic",
                "azimuthDegrees": 270,
                "elevationDegrees": 0,
            },
            {
                "id": "top",
                "view": "top-down orthographic",
                "azimuthDegrees": 0,
                "elevationDegrees": 90,
            },
        ]
        shared_constraints = (
            "Use the supplied layout template as the exact five-panel composition. Keep the subject geometry, "
            "proportions, silhouette, materials, colors, handedness, and small details identical across every panel. "
            "Render crisp low-resolution pixel art for a game sprite, with a limited palette, hard edges, nearest-neighbor "
            "pixels, no anti-aliasing, no gradients, and no perspective. Use the same scale and pixel footprint in every "
            "panel; change only the listed orthographic azimuth/elevation. Use a transparent or checkerboard backdrop. "
            "No floor, cast shadow, scenery, extra object, border, watermark, or unrequested text."
        )
        composition = "one 128x128 square sprite sheet; top row FRONT/RIGHT/BACK; bottom row LEFT/TOP; full subject visible in every panel"
        acceptance_required = [
            "exactly one readable 128x128 raster sprite sheet is returned",
            "the five template panels and FRONT/RIGHT/BACK/LEFT/TOP labels remain legible",
            "one complete subject is visible in every panel",
            "front, right, back, left, and top-down panels use the exact requested orthographic angles",
            "panels share pixel scale, framing, palette, and silhouette proportions",
            "transparent or checkerboard background is preserved",
            "no perspective render, cast shadows, watermarks, or extra objects",
        ]
        sprite_prompt = "\n".join(
            (
                "Use case: stylized-concept",
                "Asset type: 128x128 pixel-art voxel-displacement construction sprite sheet",
                "Input images: Image 1: exact five-panel layout template; Image 2: optional subject/style reference",
                f"Primary request: Create one 128x128 sprite sheet for this {subject_kind}: {normalized}.",
                f"Composition/framing: {composition}",
                f"Constraints: {shared_constraints}",
                "Output: exactly one 128x128 PNG; do not return separate angle images or a 3D render.",
            )
        )
        workflow = [
            {
                "id": "sprite-sheet",
                "operation": "generate-with-template",
                "toolInvocation": "$imagegen",
                "template": {
                    "id": "voxel-sprite-sheet-template-128",
                    "path": "integrations/voxel_displacement/reference/assets/templates/voxel-sprite-sheet-template-128.png",
                    "width": 128,
                    "height": 128,
                },
                "views": construction_views,
                "prompt": sprite_prompt,
            }
        ]

    if subject_kind == "material":
        anchor_prompt = "\n".join(
            (
                "Use case: stylized-concept",
                "Asset type: voxel-displacement reconstruction reference",
                f"Primary request: {anchor_request}",
                "Style/medium: clean 3D asset turnaround render; materially legible; no cinematic grading",
                f"Composition/framing: {composition}",
                f"Constraints: {shared_constraints}",
            )
        )
        workflow = [
            {
                "id": "anchor",
                "operation": "generate",
                "toolInvocation": "$imagegen",
                "prompt": anchor_prompt,
            }
        ]
        for view in derived:
            workflow.append(
                {
                    **view,
                    "toolInvocation": "$imagegen",
                    "prompt": "\n".join(
                        (
                            "Use case: identity-preserve",
                            "Asset type: voxel-displacement reconstruction reference",
                            "Input images: Image 1: approved anchor reference",
                            f"Primary request: {view['request']}",
                            f"Composition/framing: {composition}",
                            f"Constraints: {shared_constraints}",
                        )
                    ),
                }
            )

    return {
        "schema": REFERENCE_BRIEF_SCHEMA,
        "provider": "codex-imagegen",
        "requestedModel": "gpt-image-2",
        "modelEnforcement": "caller-must-verify-active-codex-imagegen-route",
        "executionMode": "built-in-tool",
        "subjectKind": subject_kind,
        "sourcePrompt": normalized,
        "strategy": "anchor-then-derived-views" if subject_kind == "material" else "single-template-sprite-sheet",
        "viewContract": {
            "anchorRole": "style-and-identity reference is optional; layout template is mandatory" if subject_kind != "material" else "style-and-identity-anchor",
            "template": workflow[0].get("template") if subject_kind != "material" else None,
            "constructionViews": construction_views,
            "lockedFields": ["geometry", "proportions", "scale", "framing", "lighting", "materials", "silhouette"],
        },
        "workflow": workflow,
        "acceptance": {
            "required": acceptance_required,
            "decision": "accept-or-regenerate-one-sheet" if subject_kind != "material" else "accept-or-regenerate-one-view",
            "note": (
                "Generated material maps are hypotheses, not calibrated measurements. Validate seams, channel meaning, and relief before baking."
                if subject_kind == "material"
                else "The sprite sheet is reference evidence, not proof of hidden-side geometry. Validate panel consistency before visual-hull or sculpt intake."
            ),
        },
    }
