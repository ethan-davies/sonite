import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseVersionRequirement } from "./deps/semver.js";
import type { DepSpec } from "./deps/types.js";
import {
  parseNativeConfig,
  type ParsedNativeConfig,
} from "./native-deps.js";

export interface ProjectPackage {
  readonly name: string;
  readonly version: string;
  /** Optional metadata — omitted from project.toml when unset. */
  readonly description?: string;
  readonly license?: string;
  readonly authors?: readonly string[];
  readonly documentation?: string;
  readonly repository?: string;
  readonly keywords?: readonly string[];
  readonly entry: string;
}

export interface ProjectBuild {
  readonly outdir: string;
}

export interface ProjectFormat {
  readonly indentWidth: number;
  readonly useTabs: boolean;
  readonly lineWidth: number;
}

export interface ProjectDiagnostics {
  readonly unusedImports: "off" | "warn" | "error";
  readonly unusedVariables: "off" | "warn" | "error";
  readonly unusedParameters: "off" | "warn" | "error";
  readonly unreachableCode: "off" | "warn" | "error";
}

export type OptLevelInt = 0 | 1 | 2 | 3;

/** Fully resolved build profile. */
export interface ProjectProfile {
  readonly name: string;
  readonly optimization: OptLevelInt;
  readonly debugInfo: boolean;
  readonly inherits?: string;
}

/** Raw `[profile.*]` entry before inheritance is applied. */
interface RawProfile {
  readonly name: string;
  readonly optimization?: OptLevelInt;
  readonly debugInfo?: boolean;
  readonly inherits?: string;
}

export type ProjectNative = ParsedNativeConfig;

export interface Project {
  readonly root: string;
  readonly manifestPath: string;
  readonly package: ProjectPackage;
  readonly build: ProjectBuild;
  readonly format: ProjectFormat;
  readonly diagnostics: ProjectDiagnostics;
  readonly native: ProjectNative;
  /** Production dependencies from `[dependencies]`. */
  readonly dependencies: Readonly<Record<string, DepSpec>>;
  /** Development-only dependencies from `[dev-dependencies]`. */
  readonly devDependencies: Readonly<Record<string, DepSpec>>;
  /** Forced versions from `[overrides]` (exact semver). */
  readonly overrides: Readonly<Record<string, string>>;
  /** Named build profiles from project.toml (may be partial before resolve). */
  readonly profiles: Readonly<Record<string, RawProfile>>;
  /** Absolute path to the entry .sn file. */
  readonly entryPath: string;
  /** Absolute path to the build output directory (base; profile subdirs added by build). */
  readonly outdirPath: string;
  /** Output binary basename (package.name). */
  readonly binaryName: string;
}

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * Walk upward from `startDir` looking for `project.toml`.
 * Returns the absolute path to the manifest, or null if not found.
 */
export function findProjectManifest(
  startDir: string = process.cwd(),
): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "project.toml");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Load and validate a project by searching upward from a directory (default: cwd).
 */
export function loadProject(startDir: string = process.cwd()): Project {
  const manifestPath = findProjectManifest(resolve(startDir));
  if (!manifestPath) {
    throw new ProjectError(
      "no project.toml found (run `sn init` or cd into a project directory)",
    );
  }
  return loadProjectFromManifest(manifestPath);
}

export function loadProjectFromManifest(manifestPath: string): Project {
  const absoluteManifest = resolve(manifestPath);
  if (!existsSync(absoluteManifest)) {
    throw new ProjectError(`project.toml not found: ${absoluteManifest}`);
  }

  let raw: unknown;
  try {
    raw = parseToml(readFileSync(absoluteManifest, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`failed to parse project.toml: ${message}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectError("project.toml must contain a TOML table");
  }

  const root = dirname(absoluteManifest);
  const table = raw as Record<string, unknown>;
  const pkgTable = requireTable(table, "package");
  const buildTable =
    table.build === undefined ? {} : requireTable(table, "build");

  const name = requireString(pkgTable, "name", "package.name");
  const version = requireString(pkgTable, "version", "package.version");
  const entry = requireString(pkgTable, "entry", "package.entry");
  const description = optionalString(pkgTable, "description");
  const license = optionalString(pkgTable, "license");
  const authors = optionalStringArray(pkgTable, "authors");
  const documentation = optionalString(pkgTable, "documentation");
  const repository = optionalString(pkgTable, "repository");
  const keywords = optionalStringArray(pkgTable, "keywords");
  const outdir = optionalString(buildTable, "outdir") ?? "build";
  const dependencies = parseDepTable(table, "dependencies");
  const devDependencies = parseDepTable(table, "dev-dependencies");
  const overrides = parseOverrides(table);
  const profiles = parseProfiles(table);
  const format = parseFormatTable(table);
  const diagnostics = parseDiagnosticsTable(table);
  const native = parseNativeConfig(table);

  if (!name.trim()) {
    throw new ProjectError("package.name must not be empty");
  }
  if (!entry.trim()) {
    throw new ProjectError("package.entry must not be empty");
  }

  const pkg: {
    name: string;
    version: string;
    entry: string;
    description?: string;
    license?: string;
    authors?: readonly string[];
    documentation?: string;
    repository?: string;
    keywords?: readonly string[];
  } = { name, version, entry };
  if (description !== undefined) {
    pkg.description = description;
  }
  if (license !== undefined) {
    pkg.license = license;
  }
  if (authors !== undefined) {
    pkg.authors = authors;
  }
  if (documentation !== undefined) {
    pkg.documentation = documentation;
  }
  if (repository !== undefined) {
    pkg.repository = repository;
  }
  if (keywords !== undefined) {
    pkg.keywords = keywords;
  }

  return {
    root,
    manifestPath: absoluteManifest,
    package: pkg,
    build: { outdir },
    format,
    diagnostics,
    native,
    dependencies,
    devDependencies,
    overrides,
    profiles,
    entryPath: resolve(root, entry),
    outdirPath: resolve(root, outdir),
    binaryName: name,
  };
}

/** Resolve a named profile (defaults + inheritance). */
export function resolveProfile(
  project: Project,
  name: string,
): ProjectProfile {
  const defaults = defaultProfiles();
  const merged: Record<string, RawProfile> = { ...defaults };
  for (const [key, profile] of Object.entries(project.profiles)) {
    merged[key] = profile;
  }

  const seen = new Set<string>();
  function resolveOne(profileName: string): ProjectProfile {
    if (seen.has(profileName)) {
      throw new ProjectError(
        `project.toml: profile inheritance cycle involving '${profileName}'`,
      );
    }
    seen.add(profileName);
    const profile = merged[profileName];
    if (!profile) {
      throw new ProjectError(`unknown build profile '${profileName}'`);
    }
    if (!profile.inherits) {
      return {
        name: profileName,
        optimization: profile.optimization ?? 0,
        debugInfo: profile.debugInfo ?? true,
      };
    }
    const base = resolveOne(profile.inherits);
    return {
      name: profileName,
      optimization: profile.optimization ?? base.optimization,
      debugInfo: profile.debugInfo ?? base.debugInfo,
      inherits: profile.inherits,
    };
  }

  return resolveOne(name);
}

export function defaultProfiles(): Record<string, RawProfile> {
  return {
    debug: {
      name: "debug",
      optimization: 0,
      debugInfo: true,
    },
    release: {
      name: "release",
      optimization: 2,
      debugInfo: false,
    },
  };
}

function parseProfiles(
  table: Record<string, unknown>,
): Record<string, RawProfile> {
  if (table.profile === undefined) {
    return {};
  }
  const profileTable = requireTable(table, "profile");
  const out: Record<string, RawProfile> = {};
  for (const [name, value] of Object.entries(profileTable)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProjectError(
        `project.toml: [profile.${name}] must be a table`,
      );
    }
    const row = value as Record<string, unknown>;
    const inherits =
      row.inherits === undefined
        ? undefined
        : typeof row.inherits === "string"
          ? row.inherits
          : (() => {
              throw new ProjectError(
                `project.toml: profile.${name}.inherits must be a string`,
              );
            })();

    let optimization: OptLevelInt | undefined;
    if (row.optimization !== undefined) {
      if (
        typeof row.optimization !== "number" ||
        !Number.isInteger(row.optimization) ||
        row.optimization < 0 ||
        row.optimization > 3
      ) {
        throw new ProjectError(
          `project.toml: profile.${name}.optimization must be an integer 0–3`,
        );
      }
      optimization = row.optimization as OptLevelInt;
    }

    let debugInfo: boolean | undefined;
    if (row["debug-info"] !== undefined) {
      if (typeof row["debug-info"] !== "boolean") {
        throw new ProjectError(
          `project.toml: profile.${name}.debug-info must be a boolean`,
        );
      }
      debugInfo = row["debug-info"];
    } else if (row.debug_info !== undefined) {
      if (typeof row.debug_info !== "boolean") {
        throw new ProjectError(
          `project.toml: profile.${name}.debug_info must be a boolean`,
        );
      }
      debugInfo = row.debug_info;
    }

    const raw: {
      name: string;
      optimization?: OptLevelInt;
      debugInfo?: boolean;
      inherits?: string;
    } = { name };
    if (optimization !== undefined) {
      raw.optimization = optimization;
    }
    if (debugInfo !== undefined) {
      raw.debugInfo = debugInfo;
    }
    if (inherits !== undefined) {
      raw.inherits = inherits;
    }
    out[name] = raw;
  }
  return out;
}

function parseFormatTable(table: Record<string, unknown>): ProjectFormat {
  const defaults: ProjectFormat = {
    indentWidth: 4,
    useTabs: false,
    lineWidth: 100,
  };
  if (table.format === undefined) {
    return defaults;
  }
  const formatTable = requireTable(table, "format");
  let indentWidth = defaults.indentWidth;
  let useTabs = defaults.useTabs;
  let lineWidth = defaults.lineWidth;

  if (formatTable.indent_width !== undefined) {
    if (
      typeof formatTable.indent_width !== "number" ||
      !Number.isFinite(formatTable.indent_width) ||
      formatTable.indent_width < 0
    ) {
      throw new ProjectError(
        "project.toml: format.indent_width must be a non-negative number",
      );
    }
    indentWidth = Math.floor(formatTable.indent_width);
  }
  if (formatTable.use_tabs !== undefined) {
    if (typeof formatTable.use_tabs !== "boolean") {
      throw new ProjectError(
        "project.toml: format.use_tabs must be a boolean",
      );
    }
    useTabs = formatTable.use_tabs;
  }
  if (formatTable.line_width !== undefined) {
    if (
      typeof formatTable.line_width !== "number" ||
      !Number.isFinite(formatTable.line_width) ||
      formatTable.line_width <= 0
    ) {
      throw new ProjectError(
        "project.toml: format.line_width must be a positive number",
      );
    }
    lineWidth = Math.floor(formatTable.line_width);
  }

  return { indentWidth, useTabs, lineWidth };
}

function parseDiagnosticsTable(
  table: Record<string, unknown>,
): ProjectDiagnostics {
  const defaults: ProjectDiagnostics = {
    unusedImports: "warn",
    unusedVariables: "warn",
    unusedParameters: "warn",
    unreachableCode: "warn",
  };
  if (table.diagnostics === undefined) {
    return defaults;
  }
  const diagTable = requireTable(table, "diagnostics");
  const result = { ...defaults };

  const parseLevel = (
    key: string,
    value: unknown,
  ): "off" | "warn" | "error" => {
    if (value !== "off" && value !== "warn" && value !== "error") {
      throw new ProjectError(
        `project.toml: diagnostics.${key} must be "off", "warn", or "error"`,
      );
    }
    return value;
  };

  if (diagTable.unused_imports !== undefined) {
    result.unusedImports = parseLevel("unused_imports", diagTable.unused_imports);
  }
  if (diagTable.unused_variables !== undefined) {
    result.unusedVariables = parseLevel(
      "unused_variables",
      diagTable.unused_variables,
    );
  }
  if (diagTable.unused_parameters !== undefined) {
    result.unusedParameters = parseLevel(
      "unused_parameters",
      diagTable.unused_parameters,
    );
  }
  if (diagTable.unreachable_code !== undefined) {
    result.unreachableCode = parseLevel(
      "unreachable_code",
      diagTable.unreachable_code,
    );
  }
  return result;
}

function parseOverrides(
  table: Record<string, unknown>,
): Record<string, string> {
  if (table.overrides === undefined) {
    return {};
  }
  const overridesTable = requireTable(table, "overrides");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overridesTable)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ProjectError(
        `project.toml: overrides.${key} must be a non-empty exact version string`,
      );
    }
    const trimmed = value.trim();
    try {
      const req = parseVersionRequirement(trimmed);
      if (req.kind !== "exact") {
        throw new ProjectError(
          `project.toml: overrides.${key} must be an exact version (got '${trimmed}')`,
        );
      }
    } catch (error) {
      if (error instanceof ProjectError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ProjectError(`project.toml: overrides.${key}: ${message}`);
    }
    out[key] = trimmed;
  }
  return out;
}

function parseDepTable(
  table: Record<string, unknown>,
  key: "dependencies" | "dev-dependencies",
): Record<string, DepSpec> {
  if (table[key] === undefined) {
    return {};
  }
  const depsTable = requireTable(table, key);
  const deps: Record<string, DepSpec> = {};
  for (const [depName, value] of Object.entries(depsTable)) {
    deps[depName] = parseDepSpec(key, depName, value);
  }
  return deps;
}

export function parseDepSpec(
  section: string,
  key: string,
  value: unknown,
): DepSpec {
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new ProjectError(
        `project.toml: ${section}.${key} must be a non-empty version string`,
      );
    }
    try {
      parseVersionRequirement(value.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProjectError(`project.toml: ${section}.${key}: ${message}`);
    }
    return { kind: "version", range: value.trim() };
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.git !== undefined) {
      throw new ProjectError(
        `project.toml: ${section}.${key}: git dependencies are not supported yet`,
      );
    }
    if (typeof row.path === "string" && row.path.trim()) {
      return { kind: "path", path: row.path.trim() };
    }
    throw new ProjectError(
      `project.toml: ${section}.${key} table must include path = "..."`,
    );
  }

  throw new ProjectError(
    `project.toml: ${section}.${key} must be a version string or { path = "..." }`,
  );
}

/** Resolve a path dependency relative to a project root. */
export function resolveDepPath(projectRoot: string, pathSpec: string): string {
  return isAbsolute(pathSpec) ? resolve(pathSpec) : resolve(projectRoot, pathSpec);
}

function requireTable(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectError(`project.toml: missing or invalid [${key}] table`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  table: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = table[key];
  if (typeof value !== "string") {
    throw new ProjectError(`project.toml: ${label} must be a string`);
  }
  return value;
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProjectError(`project.toml: ${key} must be a string`);
  }
  return value;
}

function optionalStringArray(
  table: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ProjectError(`project.toml: ${key} must be an array of strings`);
  }
  return value as string[];
}
