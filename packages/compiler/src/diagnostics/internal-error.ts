/**
 * Unexpected compiler bug (ICE). Distinct from user-facing diagnostics.
 * The CLI writes a crash report and prints a controlled message.
 */
export class InternalError extends Error {
  readonly phase: string;
  readonly sourceLocation: string | undefined;

  constructor(
    message: string,
    options: {
      readonly phase?: string;
      readonly cause?: unknown;
      readonly sourceLocation?: string;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "InternalError";
    this.phase = options.phase ?? "unknown";
    this.sourceLocation = options.sourceLocation;
  }

  static fromUnknown(error: unknown, phase: string): InternalError {
    if (error instanceof InternalError) {
      return error;
    }
    if (error instanceof Error) {
      return new InternalError(error.message, { phase, cause: error });
    }
    return new InternalError(String(error), { phase });
  }
}

export function isInternalError(error: unknown): error is InternalError {
  return error instanceof InternalError;
}
