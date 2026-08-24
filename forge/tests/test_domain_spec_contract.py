"""Base-side behaviour that a domain plugin's intake feeds into.

These two assertions used to live in forge/tests/test_cs2_foundation.py, which moved to the CS2
plugin. They stayed behind because they exercise *base* code -- `apply_cs2_template`,
`apply_cs2_manifest_evidence` and `validate_cs2_contract` are still in this checkout, pending the
raise-only spec-augmentation artifact that will let them leave. Fixtures are inline dicts rather than
built by the plugin's `cs2_foundation`, so this suite needs nothing from the plugin.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_shared"))
sys.path.insert(0, str(ROOT / "stage2_spec"))

from new_pre_spec_assessment import make_payload  # noqa: E402
from new_sculpt_spec import apply_cs2_manifest_evidence, apply_cs2_template, make_spec  # noqa: E402
from validate_sculpt_spec import validate_cs2_contract  # noqa: E402

# Shaped like a manifest an installed domain plugin publishes. Inline on purpose: the base must be
# testable without the plugin that normally produces this.
MANIFEST = {
    "schemaVersion": 1,
    "state": "proceed",
    "exactnessTier": "image-only",
    "route": "reference-projection",
    "identity": {"family": "knife", "subtype": "talon"},
    "sourceViews": [{"viewpoint": "reference", "hash": 1234567890, "width": 128, "height": 128}],
    "admission": {"admitted": True, "reasons": []},
    "warnings": [],
}


class DomainEvidenceReachesTheSpec(unittest.TestCase):
    def test_manifest_evidence_reaches_the_assessment_and_the_spec(self) -> None:
        payload = make_payload("Talon Doppler", "ref.png", "ultra-complex", True, MANIFEST, False)
        assessment = payload["preSpecAssessment"]
        self.assertEqual(assessment["objectClass"]["domain"], "cs2")

        spec = make_spec("Talon Doppler", "ref.png", payload)
        apply_cs2_template(spec)
        apply_cs2_manifest_evidence(spec, MANIFEST)
        contract = spec.get("qualityContract", {})
        # The domain raises the base's floors. Slice 4 moves this to a pulled artifact with a
        # raise-only merge; until then it is an in-repo post-processor and this pins its effect.
        self.assertEqual(contract.get("qualityBar"), "ultra-complex")
        self.assertEqual(spec["preSpecAssessment"]["detailInventory"]["targetMinDetails"], 16)


class DomainContractValidation(unittest.TestCase):
    def test_validator_rejects_an_invalid_exactness_and_route_pair(self) -> None:
        spec = {
            "cs2Intake": {
                "schemaVersion": 1,
                "state": "proceed",
                "exactnessTier": "exact-texture",
                "route": "procedural-approximation",
                "sourceViews": [],
                "admission": {"admitted": True},
                "warnings": [],
            }
        }
        errors: list[str] = []
        validate_cs2_contract(spec, errors, [])
        self.assertTrue(errors, "an exact-texture tier on a procedural route must be refused")

    def test_a_spec_with_no_domain_intake_is_left_alone(self) -> None:
        # The guard clause that keeps this validator off every generic run.
        errors: list[str] = []
        validate_cs2_contract({"preSpecAssessment": {}}, errors, [])
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
