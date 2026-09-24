import type { SerializedError } from "../protocol/types.js";

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof GatewayError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message, retryable: false };
  }
  return { code: "INTERNAL_ERROR", message: String(error), retryable: false };
}

