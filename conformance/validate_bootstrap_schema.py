from __future__ import annotations

import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from validation_support import (
    FORMAT_CHECKER,
    REPO_ROOT,
    describe_errors,
    load_json,
)


FIXTURE_PATH = REPO_ROOT / "conformance" / "v0.2" / "bootstrap-schema-cases.json"
RECORD_KINDS = {
    "ProjectBootstrapRequest",
    "ProjectManifest",
    "ProjectGenesisRecord",
}
MANIFEST_PHASES = {"active", "suspended", "retired"}


def main() -> int:
    fixture = load_json(FIXTURE_PATH)
    schema_path = (FIXTURE_PATH.parent / fixture["schema"]).resolve()
    schema = load_json(schema_path)

    registry = Registry()
    for relative_path in fixture["resources"]:
        resource_path = (FIXTURE_PATH.parent / relative_path).resolve()
        resource_schema = load_json(resource_path)
        resource = Resource.from_contents(resource_schema)
        registry = registry.with_resource(resource_schema["$id"], resource)

    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FORMAT_CHECKER,
    )

    failures: list[str] = []
    definitions = schema["$defs"]
    manifest_phases = set(
        definitions["ManifestStatus"]["properties"]["phase"]["enum"]
    )
    if manifest_phases != MANIFEST_PHASES:
        failures.append(
            "Manifest phase mismatch: "
            f"expected {sorted(MANIFEST_PHASES)}, found {sorted(manifest_phases)}"
        )
    for record_name in ("ProjectBootstrapRequest", "ProjectGenesisRecord"):
        if "decisionBasis" not in definitions[record_name]["required"]:
            failures.append(f"{record_name} must require decisionBasis")
    basis_type = definitions["BootstrapDecisionBasis"]["properties"]["type"]
    if basis_type.get("const") != "genesis":
        failures.append("BootstrapDecisionBasis.type must be const genesis")

    covered_kinds: set[str] = set()
    valid_count = 0
    invalid_count = 0

    for case in fixture["cases"]:
        errors = sorted(
            validator.iter_errors(case["instance"]),
            key=lambda error: list(error.absolute_path),
        )
        actual_valid = not errors
        expected_valid = case["expectedValid"]

        if expected_valid:
            valid_count += 1
            covered_kinds.add(case["instance"].get("kind", ""))
        else:
            invalid_count += 1

        if actual_valid != expected_valid:
            details = (
                "instance unexpectedly passed"
                if actual_valid
                else describe_errors(errors)
            )
            failures.append(f"{case['name']}: {details}")

    missing_kinds = RECORD_KINDS - covered_kinds
    unknown_kinds = covered_kinds - RECORD_KINDS
    if missing_kinds:
        failures.append(f"missing valid fixtures: {sorted(missing_kinds)}")
    if unknown_kinds:
        failures.append(f"unknown fixture kinds: {sorted(unknown_kinds)}")
    if invalid_count == 0:
        failures.append("at least one invalid fixture is required")

    if failures:
        print("FAIL: PKR v0.2 bootstrap schema conformance", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        "PASS: PKR v0.2 bootstrap schema; "
        f"{valid_count} valid cases, {invalid_count} invalid cases, "
        f"{len(covered_kinds)} control record kinds covered."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
