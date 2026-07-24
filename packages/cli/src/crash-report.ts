import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { InternalError, isInternalError } from "@sonite/compiler";
import { getDefaultTriple, hostPlatformId } from "@sonite/llvm";
import { getCrashesDir } from "./config.js";

export const ISSUE_TRACKER_URL =
  "https://github.com/ethan-davies/sonite/issues";

const COMPILER_VERSION = "0.0.0";

export interface CrashReportInput {
  readonly error: unknown;
  readonly phase?: string;
  readonly sourcePath?: string;
  readonly targetTriple?: string;
}

export interface CrashReportResult {
  readonly reportPath: string;
  readonly userMessage: string;
}

function stackOf(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  if (error instanceof Error && error.cause instanceof Error && error.cause.stack) {
    return error.cause.stack;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function phaseOf(error: unknown, fallback?: string): string {
  if (isInternalError(error)) {
    return error.phase;
  }
  return fallback ?? "compiler";
}

/**
 * Write a local crash report under `~/.sonite/crashes` (or `SN_CRASHES_DIR`).
 * Never uploads source or the report.
 */
export function writeCrashReport(input: CrashReportInput): CrashReportResult {
  const dir = getCrashesDir();
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(dir, `ice-${stamp}.txt`);

  let platform = "unknown";
  let triple = input.targetTriple ?? "unknown";
  try {
    platform = hostPlatformId();
  } catch {
    platform = `${process.platform}-${process.arch}`;
  }
  if (!input.targetTriple) {
    try {
      triple = getDefaultTriple();
    } catch {
      // leave unknown
    }
  }

  const phase = phaseOf(input.error, input.phase);
  const message = messageOf(input.error);
  const stack = stackOf(input.error);
  const sourceLocation =
    (isInternalError(input.error) ? input.error.sourceLocation : undefined) ??
    input.sourcePath;

  const lines = [
    "Sonite compiler internal error report",
    "=====================================",
    "",
    `Compiler version: ${COMPILER_VERSION}`,
    `Platform: ${platform}`,
    `Target: ${triple}`,
    `Host: ${hostname()}`,
    `Node: ${process.version}`,
    `Phase: ${phase}`,
    `Time: ${new Date().toISOString()}`,
    "",
    `Error: ${message}`,
    "",
  ];

  if (sourceLocation) {
    lines.push(`Source: ${sourceLocation}`, "");
  }

  if (stack) {
    lines.push("Stack trace:", stack, "");
  }

  lines.push(
    "This report was written locally and was not uploaded.",
    `Please report this issue at: ${ISSUE_TRACKER_URL}`,
    "",
  );

  writeFileSync(reportPath, lines.join("\n"), "utf8");

  const userMessage = [
    "Sonite compiler encountered an internal error.",
    "",
    `Compiler version: ${COMPILER_VERSION}`,
    `Platform: ${platform}`,
    `Target: ${triple}`,
    "",
    `A crash report was written to:`,
    reportPath,
    "",
    `Please report this issue at:`,
    ISSUE_TRACKER_URL,
  ].join("\n");

  return { reportPath, userMessage };
}

/** Handle an ICE: write report, print user message, return exit code 1. */
export function reportInternalError(
  error: unknown,
  options: { readonly sourcePath?: string; readonly phase?: string } = {},
): number {
  const ice =
    error instanceof InternalError
      ? error
      : InternalError.fromUnknown(error, options.phase ?? "compiler");
  const { userMessage } = writeCrashReport({
    error: ice,
    ...(options.sourcePath !== undefined
      ? { sourcePath: options.sourcePath }
      : {}),
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
  });
  console.error(userMessage);
  return 1;
}
