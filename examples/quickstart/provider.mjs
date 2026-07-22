import { mkdirSync, writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (!request.assignmentId || !request.sessionId || request.workspace?.kind !== "Workspace") {
    throw new Error("PKR quickstart Provider requires Assignment, Session, and Workspace");
  }
  mkdirSync("src", { recursive: true });
  writeFileSync("src/pkr-quickstart-result.txt", "PKR quickstart work completed\n", "utf8");
  process.stdout.write(JSON.stringify({
    outcome: "partial",
    completed: ["quickstart-result-produced"],
    incomplete: ["repository-verification", "acceptance"],
    blockers: [],
    evidenceIds: [],
    outputs: [{ kind: "patch", locator: "src/pkr-quickstart-result.txt" }],
    nextAction: "run the independent repository Verifier"
  }));
});
