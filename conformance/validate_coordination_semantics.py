from __future__ import annotations

import copy
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from validation_support import REPO_ROOT, load_json


FIXTURE_PATH = (
    REPO_ROOT / "conformance" / "v0.4" / "coordination-golden-path.json"
)


@dataclass
class CoordinationError(Exception):
    code: str
    message: str


class CoordinationModel:
    def __init__(self, project_id: str, sources: list[str]) -> None:
        self.project_id = project_id
        self.sequence = 0
        self.sources = set(sources)
        self.assignments: dict[str, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.leases: dict[str, dict[str, Any]] = {}
        self.workspaces: dict[str, dict[str, Any]] = {}
        self.memories: dict[str, dict[str, Any]] = {}
        self.verifications: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, str] = {"task_001": "verifying"}
        self.packages: dict[str, dict[str, Any]] = {}
        self.proposals: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.commands: dict[str, str] = {}

    def snapshot(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "assignments": copy.deepcopy(self.assignments),
            "sessions": copy.deepcopy(self.sessions),
            "leases": copy.deepcopy(self.leases),
            "workspaces": copy.deepcopy(self.workspaces),
            "memories": copy.deepcopy(self.memories),
            "verifications": copy.deepcopy(self.verifications),
            "tasks": copy.deepcopy(self.tasks),
            "packages": copy.deepcopy(self.packages),
            "proposals": copy.deepcopy(self.proposals),
            "commands": copy.deepcopy(self.commands),
        }

    def restore(self, state: dict[str, Any]) -> None:
        for key, value in state.items():
            setattr(self, key, copy.deepcopy(value))

    def emit(self, entity: str, entity_id: str, state: str, data: dict[str, Any] | None = None) -> None:
        self.sequence += 1
        self.events.append(
            {
                "sequence": self.sequence,
                "entity": entity,
                "id": entity_id,
                "state": state,
                "data": data or {},
            }
        )

    def record_command(self, command_id: str, content: dict[str, Any]) -> bool:
        digest = json.dumps(content, sort_keys=True, separators=(",", ":"))
        existing = self.commands.get(command_id)
        if existing == digest:
            return False
        if existing is not None:
            raise CoordinationError(
                "PKR-COORD-012", "idempotency key reused with different content"
            )
        self.commands[command_id] = digest
        return True

    def apply(self, step: dict[str, Any]) -> None:
        operation = step["operation"]
        handler = getattr(self, f"op_{operation}")
        handler(step)

    def op_offerAssignment(self, step: dict[str, Any]) -> None:
        content = {
            "assignmentId": step["assignmentId"],
            "taskRevision": step["taskRevision"],
            "workflowRevision": step["workflowRevision"],
            "objective": step["objective"],
        }
        if not self.record_command(step["commandId"], content):
            return
        assignment_id = step["assignmentId"]
        self.assignments[assignment_id] = {
            **content,
            "state": "offered",
        }
        self.sources.add(assignment_id)
        self.emit("Assignment", assignment_id, "offered")

    def op_openSession(self, step: dict[str, Any]) -> None:
        session_id = step["sessionId"]
        if not step["capabilities"]:
            raise CoordinationError("PKR-COORD-005", "no declared capabilities")
        self.sessions[session_id] = {
            "agentId": step["agentId"],
            "capabilities": list(step["capabilities"]),
            "state": "active",
        }
        self.sources.add(session_id)
        self.emit("AgentSession", session_id, "active")

    def op_acquireLease(self, step: dict[str, Any]) -> None:
        assignment_id = step["assignmentId"]
        if assignment_id not in self.assignments:
            raise CoordinationError("PKR-COORD-006", "assignment missing")
        session = self.sessions.get(step["sessionId"])
        if session is None or session["state"] != "active":
            raise CoordinationError("PKR-COORD-006", "active session missing")
        if step["mode"] == "exclusive":
            for lease in self.leases.values():
                if (
                    lease["assignmentId"] == assignment_id
                    and lease["mode"] == "exclusive"
                    and lease["state"] in {"active", "renewed"}
                ):
                    raise CoordinationError(
                        "PKR-COORD-007", "exclusive lease already active"
                    )
        lease_id = step["leaseId"]
        self.leases[lease_id] = {
            "assignmentId": assignment_id,
            "sessionId": step["sessionId"],
            "mode": step["mode"],
            "state": "active",
        }
        self.sources.add(lease_id)
        self.emit("Lease", lease_id, "active")

    def op_startAssignment(self, step: dict[str, Any]) -> None:
        assignment_id = step["assignmentId"]
        assignment = self.assignments[assignment_id]
        leases = [
            lease
            for lease in self.leases.values()
            if lease["assignmentId"] == assignment_id
            and lease["state"] in {"active", "renewed"}
        ]
        if not leases:
            raise CoordinationError("PKR-COORD-006", "active lease missing")
        session = self.sessions[leases[0]["sessionId"]]
        if session["state"] != "active":
            raise CoordinationError("PKR-COORD-006", "active session missing")
        assignment["state"] = "running"
        self.emit("Assignment", assignment_id, "running")

    def op_issueWorkspace(self, step: dict[str, Any]) -> None:
        assignment_id = step["assignmentId"]
        if self.assignments[assignment_id]["state"] != "running":
            raise CoordinationError("PKR-COORD-004", "assignment is not running")
        workspace_id = step["workspaceId"]
        self.workspaces[workspace_id] = {
            "assignmentId": assignment_id,
            "projectSequence": self.sequence,
        }
        self.emit("Workspace", workspace_id, "issued")

    def op_addMemory(self, step: dict[str, Any]) -> None:
        missing = set(step["sourceIds"]) - self.sources
        if missing:
            raise CoordinationError(
                "PKR-COORD-009", f"memory sources missing: {sorted(missing)}"
            )
        memory_id = step["memoryId"]
        self.memories[memory_id] = {
            "sourceIds": list(step["sourceIds"]),
            "derived": True,
            "state": "current",
        }
        self.sources.add(memory_id)
        self.emit("MemoryEntry", memory_id, "current")

    def op_callback(self, step: dict[str, Any]) -> None:
        assignment = self.assignments.get(step["assignmentId"])
        lease = self.leases.get(step["leaseId"])
        if assignment is None or lease is None:
            raise CoordinationError("PKR-COORD-008", "callback ownership missing")
        if lease["assignmentId"] != step["assignmentId"] or lease["state"] not in {
            "active",
            "renewed",
        }:
            raise CoordinationError("PKR-COORD-008", "callback lease is not active")
        if assignment["state"] != "running":
            raise CoordinationError("PKR-COORD-008", "assignment is not running")
        assignment["state"] = "submitted"
        assignment["callback"] = {
            "messageId": step["messageId"],
            "outcome": step["outcome"],
            "evidenceIds": list(step["evidenceIds"]),
        }
        self.sources.update(step["evidenceIds"])
        self.emit("Assignment", step["assignmentId"], "submitted")

    def op_verify(self, step: dict[str, Any]) -> None:
        assignment = self.assignments[step["assignmentId"]]
        callback = assignment.get("callback")
        if callback is None or callback["outcome"] != "verified":
            raise CoordinationError("PKR-COORD-008", "verified callback missing")
        verification_id = step["verificationId"]
        self.verifications[verification_id] = {
            "assignmentId": step["assignmentId"],
            "gate": step["gate"],
            "result": step["result"],
        }
        self.sources.add(verification_id)
        self.emit("Verification", verification_id, step["result"])

    def op_completeTask(self, step: dict[str, Any]) -> None:
        applicable = [
            item
            for item in self.verifications.values()
            if item["assignmentId"] == step["assignmentId"]
        ]
        if not applicable or any(item["result"] != "passed" for item in applicable):
            raise CoordinationError("PKR-COORD-004", "passed verification missing")
        self.tasks[step["taskId"]] = "done"
        self.emit("Task", step["taskId"], "done")

    def op_stagePackage(self, step: dict[str, Any]) -> None:
        missing = set(step["verificationIds"]) - set(self.verifications)
        if missing:
            raise CoordinationError("PKR-COORD-011", "package evidence missing")
        installation_id = step["installationId"]
        self.packages[installation_id] = {
            "packageId": step["packageId"],
            "digest": step["digest"],
            "state": "staged",
            "verificationIds": list(step["verificationIds"]),
        }
        self.sources.add(installation_id)
        self.emit("PackageInstallation", installation_id, "staged")

    def op_activatePackage(self, step: dict[str, Any]) -> None:
        package = self.packages.get(step["installationId"])
        if package is None or package["state"] != "staged":
            raise CoordinationError(
                "PKR-COORD-011", "only a verified staged package can activate"
            )
        package["state"] = "active"
        self.emit("PackageInstallation", step["installationId"], "active")

    def op_proposeEvolution(self, step: dict[str, Any]) -> None:
        if step["state"] != "inactive":
            raise CoordinationError(
                "PKR-COORD-004", "evolution proposal cannot start active"
            )
        missing = set(step["sourceIds"]) - self.sources
        if missing:
            raise CoordinationError("PKR-COORD-009", "proposal sources missing")
        self.proposals[step["proposalId"]] = {
            "sourceIds": list(step["sourceIds"]),
            "state": "inactive",
        }
        self.emit("EvolutionProposal", step["proposalId"], "inactive")

    def assert_workspace_current(self, workspace_id: str) -> None:
        workspace = self.workspaces[workspace_id]
        if workspace["projectSequence"] != self.sequence:
            raise CoordinationError("PKR-COORD-003", "workspace is stale")

    def replay_state(self) -> dict[str, Any]:
        replay: dict[str, dict[str, str]] = {
            "Assignment": {},
            "AgentSession": {},
            "Lease": {},
            "Task": {},
            "PackageInstallation": {},
            "EvolutionProposal": {},
        }
        for event in self.events:
            entity = event["entity"]
            if entity in replay:
                replay[entity][event["id"]] = event["state"]
        return replay


def expect_error(
    model: CoordinationModel,
    expected_code: str,
    action: Callable[[], None],
) -> str | None:
    snapshot = model.snapshot()
    event_count = len(model.events)
    try:
        action()
    except CoordinationError as error:
        if error.code != expected_code:
            return f"expected {expected_code}, received {error.code}"
        model.restore(snapshot)
        del model.events[event_count:]
        return None
    return f"expected {expected_code}, operation unexpectedly passed"


def rejection_action(model: CoordinationModel, name: str) -> Callable[[], None]:
    if name == "duplicate-exclusive-lease":
        return lambda: model.op_acquireLease(
            {
                "leaseId": "lease_002",
                "assignmentId": "assignment_001",
                "sessionId": "session_001",
                "mode": "exclusive",
            }
        )
    if name == "expired-lease-callback":
        def expired_callback() -> None:
            model.leases["lease_001"]["state"] = "expired"
            model.assignments["assignment_001"]["state"] = "running"
            model.op_callback(
                {
                    "messageId": "message_late",
                    "assignmentId": "assignment_001",
                    "leaseId": "lease_001",
                    "outcome": "verified",
                    "evidenceIds": ["artifact_late"],
                }
            )
        return expired_callback
    if name == "stale-workspace-mutation":
        return lambda: model.assert_workspace_current("workspace_001")
    if name == "orphan-memory-source":
        return lambda: model.op_addMemory(
            {
                "memoryId": "memory_orphan",
                "sourceIds": ["knowledge_missing"],
            }
        )
    if name == "failed-package-activation":
        def failed_activation() -> None:
            model.packages["installation_001"]["state"] = "failed"
            model.op_activatePackage({"installationId": "installation_001"})
        return failed_activation
    if name == "idempotency-reuse":
        return lambda: model.op_offerAssignment(
            {
                "operation": "offerAssignment",
                "commandId": "command_offer_001",
                "assignmentId": "assignment_001",
                "taskRevision": 4,
                "workflowRevision": 2,
                "objective": "Changed content under a reused command ID.",
            }
        )
    raise KeyError(name)


def main() -> int:
    fixture = load_json(FIXTURE_PATH)
    model = CoordinationModel(fixture["projectId"], fixture["initialSources"])
    failures: list[str] = []

    for step in fixture["steps"]:
        try:
            model.apply(step)
        except CoordinationError as error:
            failures.append(
                f"golden path {step['operation']} failed with {error.code}: {error.message}"
            )
            break

    expected = fixture["expected"]
    actual = {
        "assignmentState": model.assignments.get("assignment_001", {}).get("state"),
        "sessionState": model.sessions.get("session_001", {}).get("state"),
        "leaseState": model.leases.get("lease_001", {}).get("state"),
        "taskState": model.tasks.get("task_001"),
        "packageState": model.packages.get("installation_001", {}).get("state"),
        "evolutionState": model.proposals.get("proposal_001", {}).get("state"),
    }
    if actual != expected:
        failures.append(f"final state mismatch: expected {expected}, found {actual}")

    event_count_before_replay = len(model.events)
    replay = model.replay_state()
    replay_expected = {
        "assignmentState": replay["Assignment"].get("assignment_001"),
        "sessionState": replay["AgentSession"].get("session_001"),
        "leaseState": replay["Lease"].get("lease_001"),
        "taskState": replay["Task"].get("task_001"),
        "packageState": replay["PackageInstallation"].get("installation_001"),
        "evolutionState": replay["EvolutionProposal"].get("proposal_001"),
    }
    if replay_expected != expected:
        failures.append(
            f"event replay mismatch: expected {expected}, found {replay_expected}"
        )

    rejection_count = 0
    for rejection in fixture["rejections"]:
        failure = expect_error(
            model,
            rejection["expectedCode"],
            rejection_action(model, rejection["name"]),
        )
        rejection_count += 1
        if failure:
            failures.append(f"{rejection['name']}: {failure}")

    if len(model.events) != event_count_before_replay:
        failures.append("rejected operations changed the event log")
    if len(model.commands) != 1:
        failures.append("idempotency rejection changed committed command state")

    if failures:
        print("FAIL: PKR v0.4 coordination semantic conformance", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        "PASS: PKR v0.4 coordination semantics; "
        f"{len(fixture['steps'])} golden steps, {rejection_count} rejection paths, "
        f"{len(model.events)} replayable events."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
