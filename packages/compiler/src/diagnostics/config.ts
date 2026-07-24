import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findProjectToml } from "../format/config.js";
import type { Diagnostic, DiagnosticSeverity } from "./diagnostic.js";

/** Per-rule severity override in `project.toml` `[diagnostics]`. */
export type DiagnosticLevel = "off" | "warn" | "error";

export interface DiagnosticsConfig {
  readonly unusedImports: DiagnosticLevel;
  readonly unusedVariables: DiagnosticLevel;
  readonly unusedParameters: DiagnosticLevel;
  readonly unreachableCode: DiagnosticLevel;
}

export const DEFAULT_DIAGNOSTICS_CONFIG: DiagnosticsConfig = {
  unusedImports: "warn",
  unusedVariables: "warn",
  unusedParameters: "warn",
  unreachableCode: "warn",
};

/** Stable diagnostic codes for configurable warnings. */
export const DIAGNOSTIC_CODES = {
  unusedImport: "E0412",
  circularReExport: "E0413",
  unusedVariable: "E0414",
  unusedParameter: "E0415",
  unreachableCode: "E0416",
} as const;

const CODE_TO_KEY: Readonly<Record<string, keyof DiagnosticsConfig>> = {
  [DIAGNOSTIC_CODES.unusedImport]: "unusedImports",
  [DIAGNOSTIC_CODES.unusedVariable]: "unusedVariables",
  [DIAGNOSTIC_CODES.unusedParameter]: "unusedParameters",
  [DIAGNOSTIC_CODES.unreachableCode]: "unreachableCode",
};

export function resolveDiagnosticsConfig(
  partial: Partial<DiagnosticsConfig> = {},
): DiagnosticsConfig {
  return {
    unusedImports: partial.unusedImports ?? DEFAULT_DIAGNOSTICS_CONFIG.unusedImports,
    unusedVariables:
      partial.unusedVariables ?? DEFAULT_DIAGNOSTICS_CONFIG.unusedVariables,
    unusedParameters:
      partial.unusedParameters ?? DEFAULT_DIAGNOSTICS_CONFIG.unusedParameters,
    unreachableCode:
      partial.unreachableCode ?? DEFAULT_DIAGNOSTICS_CONFIG.unreachableCode,
  };
}

/**
 * Walk upward from `startPath` looking for project.toml and parse `[diagnostics]`.
 */
export function loadDiagnosticsOptions(
  startPath: string = process.cwd(),
): DiagnosticsConfig {
  const start = resolve(startPath);
  const startDir =
    existsSync(start) && statSync(start).isFile() ? dirname(start) : start;
  const manifest = findProjectToml(startDir);
  if (!manifest) {
    return { ...DEFAULT_DIAGNOSTICS_CONFIG };
  }
  return parseDiagnosticsSection(readFileSync(manifest, "utf8"));
}

/** Minimal `[diagnostics]` table parser (no full TOML dependency). */
export function parseDiagnosticsSection(toml: string): DiagnosticsConfig {
  const partial: {
    unusedImports?: DiagnosticLevel;
    unusedVariables?: DiagnosticLevel;
    unusedParameters?: DiagnosticLevel;
    unreachableCode?: DiagnosticLevel;
  } = {};
  const lines = toml.split(/\r?\n/);
  let inDiagnostics = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inDiagnostics = line === "[diagnostics]";
      continue;
    }
    if (!inDiagnostics) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());
    const level = parseLevel(value);
    if (!level) {
      continue;
    }
    if (key === "unused_imports") {
      partial.unusedImports = level;
    } else if (key === "unused_variables") {
      partial.unusedVariables = level;
    } else if (key === "unused_parameters") {
      partial.unusedParameters = level;
    } else if (key === "unreachable_code") {
      partial.unreachableCode = level;
    }
  }
  return resolveDiagnosticsConfig(partial);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseLevel(value: string): DiagnosticLevel | null {
  if (value === "off" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

/**
 * Remap configurable warning codes according to project config.
 * Non-configurable diagnostics are left unchanged.
 */
export function applyDiagnosticsConfig(
  diagnostics: readonly Diagnostic[],
  config: DiagnosticsConfig,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = d.code ? CODE_TO_KEY[d.code] : undefined;
    if (!key) {
      out.push(d);
      continue;
    }
    const level = config[key];
    if (level === "off") {
      continue;
    }
    const severity: DiagnosticSeverity = level === "error" ? "error" : "warning";
    if (d.severity === severity) {
      out.push(d);
    } else {
      out.push({ ...d, severity });
    }
  }
  return out;
}

/** Promote all warnings to errors (CLI `--warnings-as-errors`). */
export function promoteWarningsAsErrors(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return diagnostics.map((d) =>
    d.severity === "warning" ? { ...d, severity: "error" as const } : d,
  );
}

export function diagnosticsHaveErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Convenience for tests / tooling that only need the join helper. */
export function projectTomlPath(root: string): string {
  return join(root, "project.toml");
}
