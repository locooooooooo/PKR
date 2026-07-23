interface CommandSpec {
  route: string[];
  summary: string;
  options: string[];
  flags: string[];
}

export interface CliInvocation {
  help: boolean;
  helpText?: string;
}

const command = (
  route: string,
  summary: string,
  options: string[] = [],
  flags: string[] = [],
): CommandSpec => ({
  route: route.split(" "),
  summary,
  options: ["--project", ...options],
  flags,
});

const COMMANDS: CommandSpec[] = [
  command("doctor", "Check Agent-native repository readiness without mutation or command execution.", ["--provider-file", "--verification-file"], ["--adapter"]),
  command("init", "Initialize PKR authority in a repository.", ["--name", "--title", "--outcome", "--description", "--authority", "--command-id"]),
  command("setup", "Install a controlled setup fixture in an initialized repository.", [], ["--quickstart", "--force"]),
  command("run", "Create a governed Goal and backlog Task from one request.", ["--request", "--approve-by"]),
  command("status", "Show authoritative Runtime status."),
  command("diagnostics export", "Export a bounded redacted Runtime summary without record bodies."),
  command("goal create", "Create a Goal.", ["--outcome", "--actor", "--command-id"]),
  command("decision create", "Create and accept an owner Decision.", ["--question", "--choice", "--reason", "--affected", "--actor", "--command-id"]),
  command("clarification assess", "Assess goal or decision ambiguity and persist its independent state machine.", ["--intent", "--subject-kind", "--subject-id", "--subject-revision", "--trigger", "--context", "--context-file", "--signals", "--signals-file"]),
  command("clarification status", "Read one persisted clarification state machine.", ["--run", "--question-format"]),
  command("clarification list", "List persisted clarification state machines."),
  command("clarification respond", "Resolve or skip a clarification question sheet.", ["--run", "--answers-file"], ["--accept-recommended", "--skip-questions"]),
  command("task create", "Create a Task under a Goal.", ["--goal", "--objective", "--actor", "--command-id"]),
  command("agent register", "Register an Agent identity for the current host.", ["--name", "--host", "--actor", "--command-id"]),
  command("dispatch", "Dispatch a Task through the Runtime.", ["--task", "--agent", "--command-id"]),
  command("callback", "Record a non-authoritative work report without acceptance.", ["--assignment", "--callback", "--callback-file", "--outcome", "--evidence", "--command-id"]),
  command("verify", "Run independent repository Verification.", ["--task", "--assignment", "--verification-file", "--actor", "--command-id"]),
  command("events", "List ordered Runtime events.", ["--after"]),
  command("workspace", "Build a task-scoped Workspace with Git evidence.", ["--task", "--assignment", "--principal"]),
  command("memory derive", "Derive a Memory entry from exact sources.", ["--summary", "--source-kind", "--source-id", "--source-revision", "--visibility", "--actor", "--command-id"]),
  command("memory list", "List visible Memory entries.", ["--principal", "--roles"]),
  command("memory promote", "Promote Memory to governed Knowledge.", ["--memory", "--title", "--actor", "--command-id"]),
  command("profile install", "Install a starter Profile.", ["--name", "--decision", "--capabilities", "--actor", "--command-id"]),
  command("profile list", "List starter Profiles and installations."),
  command("workflow start", "Start a portable Workflow.", ["--workflow", "--task", "--command-id"]),
  command("workflow transition", "Transition a portable Workflow.", ["--run", "--to", "--context", "--command-id"]),
  command("package uninstall", "Uninstall an active Package.", ["--package", "--actor", "--command-id"]),
  command("package rollback", "Roll back a Package installation.", ["--package", "--target", "--actor", "--command-id"]),
  command("prompt register", "Register a managed Prompt.", ["--title", "--template", "--template-file", "--version", "--actor", "--command-id"]),
  command("prompt status", "Show managed Prompt status.", ["--id"]),
  command("prompt rollback", "Roll back a managed Prompt.", ["--current", "--target", "--actor", "--command-id"]),
  command("policy register", "Register a managed Policy.", ["--policy", "--policy-file", "--actor", "--command-id"]),
  command("policy status", "Show managed Policy status.", ["--id"]),
  command("policy rollback", "Roll back a managed Policy.", ["--current", "--target", "--actor", "--command-id"]),
  command("adapter register", "Register a managed Adapter contract.", ["--adapter", "--adapter-file", "--actor", "--command-id"]),
  command("adapter status", "Show managed Adapter status.", ["--id"]),
  command("adapter rollback", "Roll back a managed Adapter.", ["--current", "--target", "--actor", "--command-id"]),
  command("metric record", "Record a governed Metric observation.", ["--measure", "--source", "--window", "--operator", "--threshold", "--severity", "--value", "--actor", "--command-id", "--source-configuration"]),
  command("evolution propose", "Propose a repeated-failure candidate.", ["--candidate", "--candidate-file", "--proposer", "--threshold", "--command-id"]),
  command("evolution observe", "Record an evolution observation.", ["--candidate", "--candidate-file", "--observation", "--observation-file", "--proposer", "--command-id"]),
  command("evolution revise", "Revise an inactive candidate.", ["--id", "--candidate", "--candidate-file", "--proposer", "--command-id"]),
  command("evolution approve", "Approve a candidate with separation of duties.", ["--id", "--approver", "--command-id"]),
  command("evolution evaluate", "Evaluate a deterministic candidate.", ["--id", "--verifier", "--command-id"]),
  command("evolution external-evaluate", "Record external supervisor evidence.", ["--id", "--supervisor", "--result", "--result-file", "--command-id"]),
  command("evolution promote", "Promote a verified candidate.", ["--id", "--promoter", "--supervisor", "--command-id"]),
  command("evolution monitor", "Record independent post-promotion monitoring.", ["--id", "--observer", "--value", "--command-id"]),
  command("evolution status", "Show candidate status.", ["--id"]),
  command("steward propose", "Prepare a Steward proposal and persist any clarification state.", ["--request", "--question-format"]),
  command(
    "steward apply",
    "Apply a governed Steward proposal after any clarification and approval gates resolve.",
    ["--request", "--approve-by", "--answers-file"],
    ["--accept-recommended", "--skip-questions"],
  ),
  command(
    "project intake",
    "Clarify a project request with an optional question sheet and prepare a bootstrap proposal without mutation.",
    ["--request", "--request-file", "--name", "--title", "--outcome", "--audience", "--target", "--months", "--days", "--verification-file", "--answers-file", "--question-format"],
    ["--accept-recommended", "--skip-questions"],
  ),
  command("project bootstrap", "Create a new Git repository and initialize PKR after explicit human approval.", ["--proposal", "--proposal-file", "--approve-by"]),
  command("project plan", "Rebuild the monthly and rolling daily plan from PKR authority."),
  command("project status", "Show project bootstrap status and its derived plan."),
  command("lps claim", "Claim a Task for the current loaded Agent and return its Workspace.", ["--task", "--agent", "--session-locator"]),
  command("lps submit", "Submit current Agent work and real Git evidence without acceptance.", ["--assignment", "--agent", "--result", "--result-file", "--outcome"]),
  command("lps adapter-run", "Run one optional configured Provider Adapter lane.", ["--task", "--agent", "--provider-file"]),
  command("lps board", "Rebuild the LPS board from PKR truth."),
  command("supervise", "Reconcile one explicitly configured Supervisor action from Runtime authority.", ["--config", "--interval"], ["--once", "--watch"]),
  command("assignment cancel", "Cancel a running Assignment.", ["--assignment", "--reason"]),
  command("lease heartbeat", "Renew a live Lease.", ["--assignment"]),
  command("lease expire", "Expire a Lease and block its Task.", ["--assignment"]),
  command("digest", "Print the authoritative state digest."),
  command("projection rebuild", "Rebuild inspectable projections from authority."),
  command("projection export", "Write an explicitly lossy projection for external sharing.", ["--profile", "--output", "--max-bytes"]),
];

const TOP_LEVEL = [...new Set(COMMANDS.map((spec) => spec.route[0]!))];

function usage(spec: CommandSpec): string {
  const options = spec.options.filter((name) => name !== "--project");
  return [
    `Usage: pkr ${spec.route.join(" ")} [options]`,
    "",
    spec.summary,
    "",
    "Options:",
    "  --project <path>  Target repository (default: current directory)",
    ...options.map((name) => `  ${name} <value>`),
    ...spec.flags.map((name) => `  ${name.padEnd(18)} Enable this optional mode`),
    "  --help            Show this help without opening the Runtime",
  ].join("\n");
}

function topLevelHelp(name: string): string {
  const specs = COMMANDS.filter((spec) => spec.route[0] === name);
  if (specs.length === 1 && specs[0]!.route.length === 1) {
    return usage(specs[0]!);
  }
  return [
    `Usage: pkr ${name} <subcommand> [options]`,
    "",
    "Subcommands:",
    ...specs.map((spec) => `  ${spec.route.slice(1).join(" ").padEnd(18)} ${spec.summary}`),
    "",
    `Run 'pkr ${name} <subcommand> --help' for command options.`,
  ].join("\n");
}

export function rootHelp(): string {
  return [
    "PKR 1.2.0 stable CLI",
    "",
    "Usage: pkr <command> [options]",
    "",
    "Commands:",
    ...TOP_LEVEL.map((name) => {
      const first = COMMANDS.find((spec) => spec.route[0] === name)!;
      const summary = COMMANDS.filter((spec) => spec.route[0] === name).length === 1
        ? first.summary
        : `Manage ${name} operations.`;
      return `  ${name.padEnd(18)} ${summary}`;
    }),
    "",
    "Run 'pkr <command> --help' for command help.",
  ].join("\n");
}

function commandError(message: string): Error {
  return new Error(`${message}. Run 'pkr --help' for usage`);
}

export function parseCliInvocation(args: string[]): CliInvocation {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return { help: true, helpText: rootHelp() };
  }
  const top = args[0]!;
  if (top.startsWith("--")) {
    throw commandError(`unknown option ${top}`);
  }
  const topSpecs = COMMANDS.filter((spec) => spec.route[0] === top);
  if (topSpecs.length === 0) {
    throw commandError(`unknown command ${top}`);
  }

  if (args[1] === "--help") {
    const seenGlobal = new Set<string>();
    for (let index = 2; index < args.length; index += 1) {
      const token = args[index]!;
      if (token !== "--project") {
        throw commandError(`unknown option ${token} for ${top}`);
      }
      if (seenGlobal.has(token) || !args[index + 1] || args[index + 1]!.startsWith("--")) {
        throw commandError(`option ${token} requires one value and may appear once`);
      }
      seenGlobal.add(token);
      index += 1;
    }
    return { help: true, helpText: topLevelHelp(top) };
  }

  let spec: CommandSpec | undefined;
  if (topSpecs.some((candidate) => candidate.route.length === 2)) {
    const subcommand = args[1];
    if (!subcommand || subcommand.startsWith("--")) {
      throw commandError(`missing subcommand for ${top}`);
    }
    spec = topSpecs.find((candidate) => candidate.route[1] === subcommand);
    if (!spec) {
      throw commandError(`unknown subcommand ${top} ${subcommand}`);
    }
  } else {
    spec = topSpecs[0];
  }
  if (!spec) {
    throw commandError(`no route registered for ${top}`);
  }

  const seen = new Set<string>();
  let wantsHelp = false;
  for (let index = spec.route.length; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help") {
      if (seen.has(token)) {
        throw commandError("duplicate option --help");
      }
      seen.add(token);
      wantsHelp = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw commandError(`unexpected argument ${token} for ${spec.route.join(" ")}`);
    }
    if (spec.flags.includes(token)) {
      if (seen.has(token)) {
        throw commandError(`duplicate option ${token}`);
      }
      seen.add(token);
      continue;
    }
    if (!spec.options.includes(token)) {
      throw commandError(`unknown option ${token} for ${spec.route.join(" ")}`);
    }
    if (seen.has(token)) {
      throw commandError(`duplicate option ${token}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw commandError(`option ${token} requires a value`);
    }
    seen.add(token);
    index += 1;
  }
  return wantsHelp
    ? { help: true, helpText: usage(spec) }
    : { help: false };
}
