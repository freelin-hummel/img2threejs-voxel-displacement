"""CS2 domain profile.

An in-repo provider for now. This module is what leaves the repository when CS2 becomes its own
plugin -- at which point the harness supplies the same mapping and the base pipeline is unchanged.
"""

from __future__ import annotations

from typing import Any, Final

DOMAIN: Final[dict[str, Any]] = {
    "id": "cs2",
    "setupSteps": (
        ("cs2-contract-read", "Read grimoire/intake/cs2_intake_contract.md completely"),
        ("cs2-authoritative-classification", "Obtain an authoritative CS2 family/subtype classification record"),
        (
            "cs2-manifest",
            "python3 forge/stage1_intake/cs2_manifest.py {reference} --classification classification.json --out cs2-intake.json",
        ),
    ),
    "setupAnchorBefore": "local-spec-search",
    "passSteps": (
        (
            "cs2-review",
            "python3 forge/stage4_review/cs2_review.py --manifest cs2-intake.json --metrics cs2-review-inputs.json"
            " --scene forge/tests/fixtures/knife_review_scene.json --out cs2-review.json",
        ),
    ),
    "passAnchorBefore": "ai-review-recorded",
    "specCollection": "cs2",
}
