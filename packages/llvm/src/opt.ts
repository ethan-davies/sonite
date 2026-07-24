/** Centralized Sonite → LLVM optimization policy. */

export type OptLevel = "O0" | "O1" | "O2" | "O3";

export interface OptPolicyInput {
  readonly release?: boolean;
  /** Explicit override wins over release/debug defaults. */
  readonly optLevel?: OptLevel;
}

/**
 * Map Sonite build mode to an LLVM codegen optimization level.
 * Debug (default): O0. Release: O2.
 */
export function resolveOptLevel(input: OptPolicyInput = {}): OptLevel {
  if (input.optLevel) {
    return input.optLevel;
  }
  return input.release ? "O2" : "O0";
}
