import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { resolveSafeRepositoryPath } from "./path-safety.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const delay = Number(process.env.PKR_PROVIDER_DELAY_MS ?? "0");
  const run = () => {
    try {
      const request = JSON.parse(input) as {
        assignmentId: string;
        sessionId: string;
        workspace: { kind?: string; projectSequence?: number };
      };
      if (
        request.workspace?.kind !== "Workspace" ||
        !request.assignmentId ||
        !request.sessionId
      ) {
        throw new Error("provider requires Assignment, Session, and Workspace");
      }
      const hash = createHash("sha256")
        .update(`${request.assignmentId}:${request.workspace.projectSequence ?? 0}`)
        .digest("hex")
        .slice(0, 32);
      const writePath = process.env.PKR_PROVIDER_WRITE_FILE;
      if (writePath) {
        const target = resolveSafeRepositoryPath(process.cwd(), writePath);
        writeFileSync(target, `provider result ${hash}\n`, "utf8");
      }
      process.stdout.write(
        JSON.stringify({
          outcome: "partial",
          completed: ["provider-result-produced"],
          incomplete: ["repository-verification", "acceptance"],
          blockers: [],
          evidenceIds: [],
          outputs: writePath
            ? [{ kind: "patch", locator: writePath }]
            : [{ kind: "result", locator: `pkr://provider-results/${hash}` }],
          nextAction: "collect repository evidence and run the independent Verifier",
        }),
      );
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
  if (delay > 0) {
    setTimeout(run, delay);
  } else {
    run();
  }
});
