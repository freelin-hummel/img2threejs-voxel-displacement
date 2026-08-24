"""Domain profiles the base pipeline can run.

The base pipeline names no domain. It asks this registry what is available, and a domain contributes
its own steps, its own evidence collection and its own track. Each module in this package declares a
single `DOMAIN` mapping; registration is by presence, not by the base holding a list of names.

This is the extension point the CS2 extraction needs. Today both entries are in-repo. When a domain
moves out to a plugin, its module leaves this directory and the harness supplies the same mapping
instead -- the base pipeline does not change either way, which is the property being bought here.

Required keys:
    id                  the profile identifier a run is started with
Optional keys, each defaulting to "contributes nothing":
    setupSteps          ((step_id, command), ...) spliced into the setup phase
    setupAnchorBefore   base step id to splice before; required when setupSteps is non-empty
    passSteps           ((step_id, command), ...) spliced into every correction pass
    passAnchorBefore    base step id to splice before; required when passSteps is non-empty
    specCollection      an extra local-evidence collection to search
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Final

_PACKAGE_DIR: Final = Path(__file__).resolve().parent

_REQUIRED: Final = ("id",)
_ALLOWED: Final = {
    "id",
    "setupSteps",
    "setupAnchorBefore",
    "passSteps",
    "passAnchorBefore",
    "specCollection",
}


class DomainRegistryError(ValueError):
    pass


def _load_module(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(f"_img2_domain_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise DomainRegistryError(f"cannot load domain module {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate(entry: Any, source: Path) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise DomainRegistryError(f"{source.name}: DOMAIN must be a mapping")
    for key in _REQUIRED:
        if not entry.get(key):
            raise DomainRegistryError(f"{source.name}: DOMAIN is missing required key {key!r}")
    unknown = sorted(set(entry) - _ALLOWED)
    if unknown:
        # Refused rather than ignored: a typo'd key would otherwise silently contribute nothing.
        raise DomainRegistryError(f"{source.name}: DOMAIN has unknown key(s) {unknown}")
    for steps_key, anchor_key in (("setupSteps", "setupAnchorBefore"), ("passSteps", "passAnchorBefore")):
        if entry.get(steps_key) and not entry.get(anchor_key):
            raise DomainRegistryError(f"{source.name}: {steps_key} needs {anchor_key}")
    return entry


def registered_domains() -> dict[str, dict[str, Any]]:
    """Every domain profile available to this checkout, keyed by id."""
    found: dict[str, dict[str, Any]] = {}
    for path in sorted(_PACKAGE_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        module = _load_module(path)
        entry = getattr(module, "DOMAIN", None)
        if entry is None:
            raise DomainRegistryError(f"{path.name}: a domain module must declare DOMAIN")
        entry = _validate(entry, path)
        if entry["id"] in found:
            # Two providers claiming one id is ambiguous; the base must not pick one.
            raise DomainRegistryError(f"domain id {entry['id']!r} is declared twice")
        found[entry["id"]] = entry
    return found


def domain_profile(profile: str) -> dict[str, Any] | None:
    """The registered domain for `profile`, or None for the generic pipeline."""
    if profile == "generic":
        return None
    domains = registered_domains()
    if profile not in domains:
        known = ", ".join(sorted(["generic", *domains]))
        raise DomainRegistryError(
            f"no installed provider serves profile {profile!r}; available: {known}. "
            "Install the domain plugin that provides it, or start the run as generic."
        )
    return domains[profile]
