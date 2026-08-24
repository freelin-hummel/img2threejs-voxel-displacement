"""The domain registry is the seam that lets the base pipeline stop naming domains.

These are the refusal cases. The happy paths are covered by test_workflow_state.py's checklist
assertions, which already pin the 21 / 23 / 25 step counts per profile.
"""

from __future__ import annotations

import sys
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_shared"))

import domains  # noqa: E402
from domains import DomainRegistryError, domain_profile, registered_domains  # noqa: E402
from workflow_state import WorkflowStateError, new_state  # noqa: E402


class Registry(unittest.TestCase):
    def test_the_base_pipeline_names_no_domain(self) -> None:
        # The whole point of the change: grep the base state machine for domain names.
        for name in ("workflow_state.py", "state.py"):
            path = ROOT / "_shared" / name if name == "workflow_state.py" else ROOT / name
            body = path.read_text().lower()
            for domain in ("cs2", "character"):
                self.assertNotIn(domain, body, f"{name} still names the {domain!r} domain")

    def test_generic_resolves_to_no_domain(self) -> None:
        self.assertIsNone(domain_profile("generic"))

    def test_both_in_repo_domains_are_registered(self) -> None:
        # Two consumers, one of them destined to leave the repo. A seam with one consumer is a rename.
        self.assertEqual(sorted(registered_domains()), ["character", "cs2"])

    def test_an_unregistered_profile_fails_loud_and_names_what_is_available(self) -> None:
        with self.assertRaises(DomainRegistryError) as ctx:
            domain_profile("valorant")
        message = str(ctx.exception)
        self.assertIn("valorant", message)
        self.assertIn("no installed provider", message)
        self.assertIn("generic", message)

    def test_new_state_refuses_an_unregistered_profile_rather_than_downgrading(self) -> None:
        with self.assertRaises(WorkflowStateError) as ctx:
            new_state("ref.png", profile="valorant")
        self.assertIn("valorant", str(ctx.exception))

    def test_an_unknown_anchor_is_refused_not_appended(self) -> None:
        # Appending at the end would place a domain's setup step after the steps that consume it.
        with self.assertRaises(WorkflowStateError) as ctx:
            self._with_temp_domain(
                "anchortest",
                'DOMAIN = {"id": "anchortest", "setupSteps": (("x", "y"),), "setupAnchorBefore": "no-such-step"}',
                lambda: new_state("ref.png", profile="anchortest"),
            )
        self.assertIn("no-such-step", str(ctx.exception))

    def test_an_unknown_key_is_refused_not_ignored(self) -> None:
        with self.assertRaises(DomainRegistryError) as ctx:
            self._with_temp_domain(
                "keytest",
                'DOMAIN = {"id": "keytest", "setupStpes": ()}',
                registered_domains,
            )
        self.assertIn("setupStpes", str(ctx.exception))

    def test_steps_without_an_anchor_are_refused(self) -> None:
        with self.assertRaises(DomainRegistryError) as ctx:
            self._with_temp_domain(
                "anchorless",
                'DOMAIN = {"id": "anchorless", "passSteps": (("a", "b"),)}',
                registered_domains,
            )
        self.assertIn("passAnchorBefore", str(ctx.exception))

    def test_two_providers_claiming_one_id_is_ambiguous(self) -> None:
        with self.assertRaises(DomainRegistryError) as ctx:
            self._with_temp_domain(
                "dupe",
                'DOMAIN = {"id": "cs2"}',
                registered_domains,
            )
        self.assertIn("declared twice", str(ctx.exception))

    def _with_temp_domain(self, stem: str, body: str, action):
        """Drop a domain module into the package for one assertion, then remove it."""
        path = Path(domains.__file__).resolve().parent / f"zz_{stem}.py"
        path.write_text(textwrap.dedent(body) + "\n")
        try:
            return action()
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
