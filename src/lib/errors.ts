export type ErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE"
  | "INVALID_TRANSITION"
  | "UNAUTHENTICATED"
  | "BLOCKED";

const httpStatus: Record<ErrorCode, number> = {
  VALIDATION: 422,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE: 409,
  INVALID_TRANSITION: 409,
  UNAUTHENTICATED: 401,
  BLOCKED: 409,
};

export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fields?: Record<string, string>,
    public details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return httpStatus[this.code];
  }
}

export const fail = {
  validation: (fields: Record<string, string>, message = "Some fields need attention.") =>
    new DomainError("VALIDATION", message, fields),
  forbidden: (message = "You don't have access to do this.") => new DomainError("FORBIDDEN", message),
  notFound: (what = "Record") => new DomainError("NOT_FOUND", `${what} not found.`),
  conflict: (message: string) => new DomainError("CONFLICT", message),
  stale: (latest: unknown) =>
    new DomainError("STALE", "This record changed since you opened it. Review the latest values and reapply your change.", undefined, latest),
  transition: (from: string, to: string) =>
    new DomainError("INVALID_TRANSITION", `Status cannot move from ${from} to ${to}.`),
  blocked: (message: string, details?: unknown) => new DomainError("BLOCKED", message, undefined, details),
};
