import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { PkrError } from "./errors.js";

function loadJson(path: string): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) {
    return "unknown validation error";
  }
  return errors
    .slice(0, 6)
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
}

export class ContractValidator {
  private readonly objectValidator: ValidateFunction;
  private readonly bootstrapValidator: ValidateFunction;
  private readonly coordinationValidator: ValidateFunction;

  constructor(repositoryRoot: string) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
        !Number.isNaN(Date.parse(value)),
    });
    ajv.addFormat("uri", {
      type: "string",
      validate: (value: string) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol.length > 1;
        } catch {
          return false;
        }
      },
    });
    ajv.addFormat("uri-reference", {
      type: "string",
      validate: (value: string) => value.length > 0 && !/\s/.test(value),
    });

    const objectSchema = loadJson(
      join(repositoryRoot, "schemas", "v0.2", "pkr-object.schema.json"),
    );
    const bootstrapSchema = loadJson(
      join(repositoryRoot, "schemas", "v0.2", "pkr-bootstrap.schema.json"),
    );
    const runtimeSchema = loadJson(
      join(repositoryRoot, "schemas", "v0.2", "pkr-runtime.schema.json"),
    );
    const coordinationSchema = loadJson(
      join(repositoryRoot, "schemas", "v0.4", "pkr-coordination.schema.json"),
    );

    ajv.addSchema(objectSchema);
    ajv.addSchema(bootstrapSchema);
    ajv.addSchema(runtimeSchema);
    ajv.addSchema(coordinationSchema);

    this.objectValidator = ajv.getSchema(
      "https://pkr.dev/schemas/v0.2/pkr-object.schema.json",
    )!;
    this.bootstrapValidator = ajv.getSchema(
      "https://pkr.dev/schemas/v0.2/pkr-bootstrap.schema.json",
    )!;
    this.coordinationValidator = ajv.getSchema(
      "https://pkr.dev/schemas/v0.4/pkr-coordination.schema.json",
    )!;
  }

  validateObject(value: unknown): void {
    if (!this.objectValidator(value)) {
      throw new PkrError(
        "PKR-SCHEMA-VALIDATION",
        `Core object failed validation: ${formatErrors(this.objectValidator.errors)}`,
      );
    }
  }

  validateBootstrap(value: unknown): void {
    if (!this.bootstrapValidator(value)) {
      throw new PkrError(
        "PKR-BOOTSTRAP-003",
        `Bootstrap record failed validation: ${formatErrors(this.bootstrapValidator.errors)}`,
      );
    }
  }

  validateCoordination(value: unknown): void {
    if (!this.coordinationValidator(value)) {
      throw new PkrError(
        "PKR-COORD-002",
        `Coordination record failed validation: ${formatErrors(this.coordinationValidator.errors)}`,
      );
    }
  }
}
