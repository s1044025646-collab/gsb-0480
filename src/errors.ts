export type ErrorCode =
  | "INVALID_ANGLE"
  | "INVALID_TIMESTAMP"
  | "NON_FINITE"
  | "INVALID_SAMPLE"
  | "INVALID_BLOCK"
  | "SEQ_MISMATCH"
  | "SEQ_REPLAY_CONFLICT"
  | "STREAM_NOT_FOUND"
  | "STREAM_ENDED"
  | "BUDGET_EXCEEDED"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400,
    public detail?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}
