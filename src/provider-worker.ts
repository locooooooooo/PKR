import { createHash } from "node:crypto";

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
      process.stdout.write(
        JSON.stringify({
          outcome: "partial",
          completed: ["provider-work-reported"],
          incomplete: ["independent-verification"],
          blockers: [],
          evidenceIds: [`artifact_provider_${hash}`],
          nextAction: "verify",
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
