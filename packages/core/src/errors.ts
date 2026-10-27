import type { JsonValue, SerializedError } from "./types.js";

export const P2PLinkErrorCodes = {
  OFFLINE: "OFFLINE",
  TIMEOUT: "TIMEOUT",
  PROTOCOL: "PROTOCOL",
  AUTH_FAILED: "AUTH_FAILED",
  FORBIDDEN: "FORBIDDEN",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  TRANSPORT_UNAVAILABLE: "TRANSPORT_UNAVAILABLE",
  TRANSPORT_SEND_FAILED: "TRANSPORT_SEND_FAILED",
  HANDLER_ERROR: "HANDLER_ERROR",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  SESSION_CLOSED: "SESSION_CLOSED",
  SESSION_RESET: "SESSION_RESET",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  REPLAY_DETECTED: "REPLAY_DETECTED",
  DECRYPT_FAILED: "DECRYPT_FAILED",
  KEY_EXHAUSTED: "KEY_EXHAUSTED",
  CAPABILITY_INVALID: "CAPABILITY_INVALID",
  CAPABILITY_USED: "CAPABILITY_USED",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  INVALID_CONFIG: "INVALID_CONFIG",
  CLOSED: "CLOSED",
  ABORTED: "ABORTED",
} as const;

export type P2PLinkErrorCode =
  (typeof P2PLinkErrorCodes)[keyof typeof P2PLinkErrorCodes] | (string & {});

export interface P2PLinkErrorOptions {
  retryable?: boolean;
  outcomeUnknown?: boolean;
  details?: JsonValue;
  cause?: unknown;
}

export class P2PLinkError extends Error {
  readonly code: P2PLinkErrorCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly details?: JsonValue;

  constructor(code: P2PLinkErrorCode, message: string, options: P2PLinkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "P2PLinkError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    if (options.details !== undefined) this.details = options.details;
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      outcomeUnknown: this.outcomeUnknown,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  static from(error: unknown): P2PLinkError {
    if (error instanceof P2PLinkError) return error;
    if (error instanceof Error) {
      return new P2PLinkError(P2PLinkErrorCodes.HANDLER_ERROR, error.message, { cause: error });
    }
    return new P2PLinkError(P2PLinkErrorCodes.HANDLER_ERROR, String(error), { cause: error });
  }

  static fromSerialized(error: SerializedError): P2PLinkError {
    return new P2PLinkError(error.code, error.message, {
      retryable: error.retryable,
      outcomeUnknown: error.outcomeUnknown,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
}

export function isP2PLinkError(error: unknown): error is P2PLinkError {
  return error instanceof P2PLinkError;
}

export function isSerializedError(value: unknown): value is SerializedError {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.outcomeUnknown === "boolean"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
