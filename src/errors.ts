export class PkrError extends Error {
  readonly code: string;
  readonly status: "rejected" | "conflict";

  constructor(
    code: string,
    message: string,
    status: "rejected" | "conflict" = "rejected",
  ) {
    super(message);
    this.name = "PkrError";
    this.code = code;
    this.status = status;
  }
}

export function isPkrError(error: unknown): error is PkrError {
  return error instanceof PkrError;
}
