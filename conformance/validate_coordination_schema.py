from __future__ import annotations

import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from validation_support import FORMAT_CHECKER, REPO_ROOT, describe_errors, load_json


FIXTURE_PATH = (
    REPO_ROOT / "conformance" / "v0.4" / "coordination-schema-cases.json"
)
RECORD_KINDS = {
    "WorkflowRun",
    "CapabilityStatement",
    "Assignment",
    "AgentSession",
    "Lease",
    "AgentMessage",
    "WorkspaceRequest",
    "Workspace",
    "MemoryEntry",
    "MemoryProjection",
    "PackageManifest",
    "PackageInstallation",
    "CoordinationCommand",
    "CoordinationEvent",
    "CoordinationResult",
}
ACTIONS = {
    "startWorkflowRun",
    "transitionWorkflowRun",
    "recordVerificationAttempt",
    "offerAssignment",
    "respondAssignment",
    "openAgentSession",
    "closeAgentSession",
    "acquireLease",
    "renewLease",
    "releaseLease",
    "revokeLease",
    "submitAgentMessage",
    "proposePackageInstall",
    "resolvePackageInstall",
    "stagePackageInstall",
    "activatePackageInstall",
    "suspendPackageInstall",
    "uninstallPackage",
    "rollbackPackage",
}
FAMILY_DEFINITIONS = {
    "pkr-workflow.schema.json": "WorkflowFamily",
    "pkr-agent.schema.json": "AgentFamily",
    "pkr-context.schema.json": "ContextFamily",
    "pkr-package.schema.json": "PackageFamily",
    "pkr-coordination-runtime.schema.json": "ProtocolFamily",
}


def main() -> int:
    fixture = load_json(FIXTURE_PATH)
    schema_path = (FIXTURE_PATH.parent / fixture["schema"]).resolve()
    schema = load_json(schema_path)

    registry = Registry().with_resource(
        schema["$id"], Resource.from_contents(schema)
    )
    resources: dict[str, dict] = {}
    for relative_path in fixture["resources"]:
        resource_path = (FIXTURE_PATH.parent / relative_path).resolve()
        resource = load_json(resource_path)
        resources[resource_path.name] = resource
        registry = registry.with_resource(
            resource["$id"], Resource.from_contents(resource)
        )

    failures: list[str] = []
    Draft202012Validator.check_schema(schema)
    for name, resource in resources.items():
        Draft202012Validator.check_schema(resource)
        expected = FAMILY_DEFINITIONS.get(name)
        if expected is None:
            failures.append(f"unexpected family schema {name}")
            continue
        expected_ref = f"{schema['$id']}#/$defs/{expected}"
        if resource.get("$ref") != expected_ref:
            failures.append(f"{name} does not reference {expected}")

    if set(resources) != set(FAMILY_DEFINITIONS):
        failures.append("family schema inventory mismatch")

    validator = Draft202012Validator(
        schema,
        registry=registry,
        format_checker=FORMAT_CHECKER,
    )
    covered_records: set[str] = set()
    covered_actions: set[str] = set()
    valid_count = 0
    invalid_count = 0

    for case in fixture["validCases"]:
        valid_count += 1
        instance = case["instance"]
        errors = sorted(
            validator.iter_errors(instance),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            failures.append(f"{case['name']}: {describe_errors(errors)}")
            continue
        covered_records.add(instance["kind"])
        if instance["kind"] == "CoordinationCommand":
            covered_actions.add(instance["action"])

    for case in fixture["invalidCases"]:
        invalid_count += 1
        errors = list(validator.iter_errors(case["instance"]))
        if not errors:
            failures.append(f"{case['name']}: instance unexpectedly passed")

    if covered_records != RECORD_KINDS:
        failures.append(
            "record coverage mismatch: "
            f"expected {sorted(RECORD_KINDS)}, found {sorted(covered_records)}"
        )
    if covered_actions != ACTIONS:
        failures.append(
            "action coverage mismatch: "
            f"expected {sorted(ACTIONS)}, found {sorted(covered_actions)}"
        )
    if len(schema["oneOf"]) != 5:
        failures.append("top-level schema must expose five exact family branches")
    if len(schema["$defs"]["CoordinationCommand"]["oneOf"]) != len(ACTIONS):
        failures.append("each coordination action must have one exact schema branch")
    control_and_projection_kinds = RECORD_KINDS - {
        "CoordinationCommand",
        "CoordinationEvent",
        "CoordinationResult",
    }
    minimum_invalid = len(control_and_projection_kinds) + len(ACTIONS) + 2
    if invalid_count < minimum_invalid:
        failures.append("targeted negative fixture coverage is incomplete")

    if failures:
        print("FAIL: PKR v0.4 coordination schema conformance", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        "PASS: PKR v0.4 coordination schemas; "
        f"{valid_count} valid cases, {invalid_count} invalid cases, "
        f"{len(covered_records)} record kinds and {len(covered_actions)} actions covered."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
