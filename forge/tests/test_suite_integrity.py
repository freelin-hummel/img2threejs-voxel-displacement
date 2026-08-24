"""The suite must not shrink silently.

A module that fails to import does not fail loudly under unittest discovery -- it is replaced by a
single synthetic `_FailedTest`, so N real tests become 1 error and the count drops without anything
naming what went missing. That is not hypothetical here: a module-scope
`from cs2_review import load_review_scene` in forge/stage4_review/append_review.py meant a missing
domain module turned test_structure_gates.py's thirteen base structural-gate tests into one loader
error. Measured: `Ran 13 tests ... OK` became `Ran 1 test ... FAILED (errors=1)`.

These two checks make that class of loss visible on its own terms, rather than as a number a human
has to notice moving.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from functools import lru_cache
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent

# Raise this deliberately when tests are added; never lower it to make a red suite green. A drop
# means tests stopped being collected, which is the failure this file exists to catch.
#
# Lowered once, deliberately and with accounting: 1134 -> 1125 when the CS2 domain moved to its own
# plugin. Nine tests left this suite: 2 oracle-replay and 5 cs2_review unit tests now run in the
# plugin's standalone suite, 1 asserted a profile collection the plugin owns, and 1 needed both the
# base's append_review and the plugin's cs2_review so it could live on neither side. Relocated, not
# lost -- and the import guard above is what caught test_cs2_foundation going dark during the move.
COLLECTED_FLOOR = 1125


REPO_ROOT = TESTS_DIR.parents[1]

# Discovery MUST run in a fresh interpreter. Discovering the suite from inside the suite is both
# order- and path-dependent: importing a test module runs its module-level sys.path.insert calls, so
# a second in-process discover resolves imports against a path the first one did not have. Measured:
# with a broken module shadowing a real one, the first in-process discover saw 1097 tests and 4
# unittest.loader._FailedTest entries, and a second discover in the same process saw a clean 1124
# and zero -- so whichever check happened to run second reported the suite healthy. A subprocess has
# one import world and cannot drift like that.
_PROBE = """
import json, unittest
def leaves(s):
    for x in s:
        if isinstance(x, unittest.TestSuite):
            yield from leaves(x)
        else:
            yield x
tests = list(leaves(unittest.TestLoader().discover("forge/tests", pattern="test_*.py")))
print(json.dumps({
    "collected": len(tests),
    "failed": [t.id() for t in tests if type(t).__name__ == "_FailedTest"],
}))
"""


@lru_cache(maxsize=1)
def _discover() -> dict:
    # Cached: the subprocess imports every test module, so calling it once per assertion cost ~22s
    # of the suite's wall clock for an identical answer.
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError(f"test discovery itself failed:\n{proc.stderr}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


class SuiteIntegrity(unittest.TestCase):
    def test_no_module_fails_to_import(self) -> None:
        broken = _discover()["failed"]
        self.assertEqual(
            broken,
            [],
            "a test module failed to import, so its tests were replaced by one synthetic error "
            "instead of running: " + "; ".join(broken),
        )

    def test_collected_count_has_not_dropped(self) -> None:
        collected = _discover()["collected"]
        self.assertGreaterEqual(
            collected,
            COLLECTED_FLOOR,
            f"the suite collects {collected} tests but the recorded floor is {COLLECTED_FLOOR}. "
            "Tests stopped being collected. Find out which module stopped importing before "
            "touching this number.",
        )


if __name__ == "__main__":
    unittest.main()
