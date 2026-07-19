from __future__ import annotations

import sys

from jsonschema import Draft202012Validator

from validation_support import (
    FORMAT_CHECKER,
    REPO_ROOT,
    describe_errors,
    load_json,
)


FIXTURE_PATH = REPO_ROOT / "conformance" / "v0.2" / "core-schema-cases.json"
CORE_KINDS = {
    "Mission",
    "Goal",
    "Task",
    "Knowledge",
    "Decision",
    "Constraint",
    "Workflow",
    "Verification",
    "Artifact",
    "Metric",
    "Agent",
    "Role",
    "Issue",
    "Release",
}
CORE_PHASES = {
    "Mission": {"draft", "active", "achieved", "retired"},
    "Goal": {"proposed", "active", "blocked", "achieved", "cancelled"},
    "Task": {"backlog", "ready", "inProgress", "blocked", "verifying", "done", "cancelled"},
    "Knowledge": {"draft", "active", "deprecated"},
    "Decision": {"proposed", "accepted", "rejected", "superseded"},
    "Constraint": {"proposed", "active", "waived", "retired"},
    "Workflow": {"draft", "active", "deprecated"},
    "Verification": {"pending", "running", "passed", "failed", "waived", "cancelled"},
    "Artifact": {"declared", "available", "invalidated", "archived"},
    "Metric": {"defined", "collecting", "healthy", "breached", "retired"},
    "Agent": {"registered", "active", "suspended", "retired"},
    "Role": {"draft", "active", "retired"},
    "Issue": {"open", "triaged", "inProgress", "resolved", "closed", "cancelled"},
    "Release": {"planned", "assembling", "verifying", "released", "rolledBack", "superseded", "cancelled"},
}
CORE_RELATIONS = {
    "contributesTo",
    "governedBy",
    "constrainedBy",
    "informedBy",
    "decidedBy",
    "assignedTo",
    "actsAs",
    "produces",
    "verifies",
    "blocks",
    "includes",
    "supersedes",
    "derivedFrom",
}
def main() -> int:
    fixture = load_json(FIXTURE_PATH)
    schema_path = (FIXTURE_PATH.parent / fixture["schema"]).resolve()
    schema = load_json(schema_path)

    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FORMAT_CHECKER)

    failures: list[str] = []
    definitions = schema["$defs"]
    for kind, expected_phases in CORE_PHASES.items():
        actual_phases = set(definitions[f"{kind}Status"]["properties"]["phase"]["enum"])
        if actual_phases != expected_phases:
            failures.append(
                f"{kind} phase mismatch: expected {sorted(expected_phases)}, "
                f"found {sorted(actual_phases)}"
            )
    actual_relations = set(
        definitions["Relation"]["properties"]["type"]["oneOf"][0]["enum"]
    )
    if actual_relations != CORE_RELATIONS:
        failures.append(
            "core relation mismatch: "
            f"expected {sorted(CORE_RELATIONS)}, found {sorted(actual_relations)}"
        )

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
            if actual_valid:
                details = "instance unexpectedly passed"
            else:
                details = describe_errors(errors)
            failures.append(f"{case['name']}: {details}")

    missing_kinds = CORE_KINDS - covered_kinds
    unknown_kinds = covered_kinds - CORE_KINDS
    if missing_kinds:
        failures.append(f"missing valid fixtures: {sorted(missing_kinds)}")
    if unknown_kinds:
        failures.append(f"unknown fixture kinds: {sorted(unknown_kinds)}")
    if invalid_count == 0:
        failures.append("at least one invalid fixture is required")

    if failures:
        print("FAIL: PKR v0.2 core schema conformance", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        "PASS: PKR v0.2 core schema; "
        f"{valid_count} valid cases, {invalid_count} invalid cases, "
        f"{len(covered_kinds)} core kinds covered."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
