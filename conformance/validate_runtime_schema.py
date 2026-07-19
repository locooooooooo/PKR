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


FIXTURE_PATH = REPO_ROOT / "conformance" / "v0.2" / "runtime-schema-cases.json"
RECORD_KINDS = {"RuntimeCommand", "RuntimeEvent", "CommandResult"}
ACTIONS = {
    "createObject",
    "replaceObject",
    "addRelation",
    "removeRelation",
    "transitionObject",
    "updateManifest",
}


def main() -> int:
    fixture = load_json(FIXTURE_PATH)
    schema_path = (FIXTURE_PATH.parent / fixture["schema"]).resolve()
    schema = load_json(schema_path)

    registry = Registry()
    resources: dict[str, dict] = {}
    for relative_path in fixture["resources"]:
        resource_path = (FIXTURE_PATH.parent / relative_path).resolve()
        resource_schema = load_json(resource_path)
        resources[resource_schema["$id"]] = resource_schema
        registry = registry.with_resource(
            resource_schema["$id"],
            Resource.from_contents(resource_schema),
        )

    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FORMAT_CHECKER,
    )

    failures: list[str] = []
    core_schema = resources[
        "https://pkr.dev/schemas/v0.2/pkr-object.schema.json"
    ]
    core_definitions = core_schema["$defs"]
    runtime_definitions = schema["$defs"]

    core_kinds = {
        reference["$ref"].rsplit("/", 1)[-1]
        for reference in core_schema["oneOf"]
    }
    for kind in core_kinds:
        expected_phases = set(
            core_definitions[f"{kind}Status"]["properties"]["phase"]["enum"]
        )
        actual_phases = set(
            runtime_definitions[f"{kind}TransitionPayload"]
            ["properties"]["toPhase"]["enum"]
        )
        if actual_phases != expected_phases:
            failures.append(
                f"{kind} transition phases differ from Core Schema"
            )

    basis_branches = runtime_definitions["DecisionBasis"]["oneOf"]
    basis_types = {
        branch["properties"]["type"]["const"] for branch in basis_branches
    }
    if basis_types != {"decision", "operational"}:
        failures.append(
            "Runtime DecisionBasis must contain only decision and operational"
        )

    covered_records: set[str] = set()
    covered_actions: set[str] = set()
    covered_intents: set[str] = set()
    valid_count = 0
    invalid_count = 0

    for case in fixture["cases"]:
        errors = sorted(
            validator.iter_errors(case["instance"]),
            key=lambda error: list(error.absolute_path),
        )
        actual_valid = not errors
        expected_valid = case["expectedValid"]
        instance = case["instance"]

        if expected_valid:
            valid_count += 1
            covered_records.add(instance.get("kind", ""))
            if instance.get("kind") == "RuntimeCommand":
                covered_actions.add(instance.get("action", ""))
                if instance.get("action") == "createObject":
                    covered_intents.add(
                        instance.get("payload", {}).get("object", {}).get("kind", "")
                    )
        else:
            invalid_count += 1

        if actual_valid != expected_valid:
            details = (
                "instance unexpectedly passed"
                if actual_valid
                else describe_errors(errors)
            )
            failures.append(f"{case['name']}: {details}")

    if covered_records != RECORD_KINDS:
        failures.append(
            f"record coverage mismatch: expected {sorted(RECORD_KINDS)}, "
            f"found {sorted(covered_records)}"
        )
    if covered_actions != ACTIONS:
        failures.append(
            f"action coverage mismatch: expected {sorted(ACTIONS)}, "
            f"found {sorted(covered_actions)}"
        )
    if covered_intents != core_kinds:
        failures.append(
            f"Object Intent coverage mismatch: expected {sorted(core_kinds)}, "
            f"found {sorted(covered_intents)}"
        )
    if invalid_count == 0:
        failures.append("at least one invalid fixture is required")

    if failures:
        print("FAIL: PKR v0.2 Runtime Protocol conformance", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        "PASS: PKR v0.2 Runtime Protocol; "
        f"{valid_count} valid cases, {invalid_count} invalid cases, "
        f"{len(covered_actions)} actions and {len(covered_intents)} intents covered."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
