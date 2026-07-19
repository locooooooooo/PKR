import type { JsonObject } from "./types.js";
import type { PortableWorkflowDefinition } from "./workflow.js";

export type StarterProfileName = "web" | "library";

export interface ProfilePackage {
  packageId: string;
  version: string;
  title: string;
  requestedCapabilities: string[];
  dependencies: Array<{ packageId: string; versionRange: string; optional: boolean }>;
  workflow: PortableWorkflowDefinition;
}

const webWorkflow: PortableWorkflowDefinition = {
  initial: "plan",
  terminal: ["released"],
  states: ["plan", "implement", "test", "preview", "released"],
  transitions: [
    { name: "plan-approved", from: "plan", to: "implement", when: { op: "eq", path: "approved", value: true } },
    { name: "implementation-complete", from: "implement", to: "test", when: { op: "eq", path: "implementation", value: "complete" } },
    { name: "tests-passed", from: "test", to: "preview", when: { op: "eq", path: "tests", value: "passed" } },
    { name: "preview-accepted", from: "preview", to: "released", when: { op: "eq", path: "preview", value: "accepted" } },
  ],
  verificationPolicy: ["test", "acceptance"],
};

const libraryWorkflow: PortableWorkflowDefinition = {
  initial: "design",
  terminal: ["published"],
  states: ["design", "implement", "compatibility", "package", "published"],
  transitions: [
    { name: "api-frozen", from: "design", to: "implement", when: { op: "eq", path: "api", value: "frozen" } },
    { name: "implementation-complete", from: "implement", to: "compatibility", when: { op: "eq", path: "implementation", value: "complete" } },
    { name: "compatibility-passed", from: "compatibility", to: "package", when: { op: "eq", path: "compatibility", value: "passed" } },
    { name: "package-verified", from: "package", to: "published", when: { op: "eq", path: "package", value: "verified" } },
  ],
  verificationPolicy: ["test", "security", "acceptance"],
};

export const STARTER_PROFILES: Record<StarterProfileName, ProfilePackage> = {
  web: {
    packageId: "dev.pkr.profile.web",
    version: "0.7.0",
    title: "PKR Web Project Profile",
    requestedCapabilities: ["filesystem.read", "filesystem.write", "terminal"],
    dependencies: [],
    workflow: webWorkflow,
  },
  library: {
    packageId: "dev.pkr.profile.library",
    version: "0.7.0",
    title: "PKR Library Project Profile",
    requestedCapabilities: ["filesystem.read", "filesystem.write", "terminal"],
    dependencies: [],
    workflow: libraryWorkflow,
  },
};

export function profileDefinition(profile: ProfilePackage): JsonObject {
  return JSON.parse(JSON.stringify(profile.workflow)) as JsonObject;
}
