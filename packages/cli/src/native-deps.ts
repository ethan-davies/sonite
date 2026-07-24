import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostRuntimePlatformId, type RuntimePlatformId } from "@sonite/runtime";

/** Phase 5 supported native package targets (Windows ARM64 excluded). */
export const NATIVE_PACKAGE_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "macos-x64",
  "macos-arm64",
  "win32-x64",
] as const;

export type NativePackageTarget = (typeof NATIVE_PACKAGE_TARGETS)[number];

export type NativeArtifactKind = "static" | "dynamic";
export type NativeLinkPreference = "static" | "dynamic" | "auto";

/** Raw `[native]` / `[native.<platform>]` table contents. */
export interface NativeConfigSection {
  readonly libraries: readonly string[];
  readonly libraryPaths: readonly string[];
  readonly linkArgs: readonly string[];
  /** Documented only — not consumed by the compiler. */
  readonly headers: readonly string[];
  /** Explicit artifact filename for this platform (e.g. `libfoo.a`). */
  readonly library?: string;
}

/** Full native configuration from a project.toml. */
export interface ParsedNativeConfig {
  readonly base: NativeConfigSection;
  readonly platforms: ReadonlyMap<string, NativeConfigSection>;
  /** Distributed native dependency identity. */
  readonly name?: string;
  readonly version?: string;
  readonly kind?: NativeArtifactKind;
  /** Preferred link mode when both static and dynamic artifacts exist. */
  readonly link: NativeLinkPreference;
  /** Explicit system libraries — never downloaded. */
  readonly systemLibraries: readonly string[];
}

/** Resolved link inputs for the host platform. */
export interface NativeLinkSpec {
  /** Absolute paths to static/dynamic library files (link inputs). */
  readonly libraryFiles: readonly string[];
  /** Directories to add as library search paths. */
  readonly libraryPaths: readonly string[];
  /** System library names for `-l` / equivalent. */
  readonly systemLibraries: readonly string[];
  /** Raw linker arguments (e.g. `-pthread`). */
  readonly linkArgs: readonly string[];
  readonly headers: readonly string[];
  /** Dynamic libraries to copy next to the application binary. */
  readonly runtimeLibraries: readonly string[];
}

const EMPTY_SECTION: NativeConfigSection = {
  libraries: [],
  libraryPaths: [],
  linkArgs: [],
  headers: [],
};

const BASE_SCALAR_KEYS = new Set([
  "libraries",
  "library_paths",
  "link_args",
  "headers",
  "library",
  "name",
  "version",
  "kind",
  "link",
]);

function parseStringArray(
  table: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = table[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`project.toml: ${label} must be an array of strings`);
  }
  return value.map((v) => (v as string).trim()).filter((v) => v.length > 0);
}

function parseOptionalString(
  table: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`project.toml: ${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseNativeSection(
  table: Record<string, unknown>,
  label: string,
): NativeConfigSection {
  const library = parseOptionalString(table, "library", `${label}.library`);
  const section: NativeConfigSection = {
    libraries: parseStringArray(table, "libraries", `${label}.libraries`),
    libraryPaths: parseStringArray(
      table,
      "library_paths",
      `${label}.library_paths`,
    ),
    linkArgs: parseStringArray(table, "link_args", `${label}.link_args`),
    headers: parseStringArray(table, "headers", `${label}.headers`),
  };
  if (library !== undefined) {
    return { ...section, library };
  }
  return section;
}

function mergeSections(
  ...sections: NativeConfigSection[]
): NativeConfigSection {
  let library: string | undefined;
  for (const s of sections) {
    if (s.library !== undefined) {
      library = s.library;
    }
  }
  const merged: NativeConfigSection = {
    libraries: sections.flatMap((s) => s.libraries),
    libraryPaths: sections.flatMap((s) => s.libraryPaths),
    linkArgs: sections.flatMap((s) => s.linkArgs),
    headers: sections.flatMap((s) => s.headers),
  };
  if (library !== undefined) {
    return { ...merged, library };
  }
  return merged;
}

/**
 * Map runtime platform id to project.toml `[native.*]` keys.
 * Accepts both `macos-*` and `darwin` aliases; Windows uses `windows` / `win32`.
 */
export function nativePlatformKeys(platform: RuntimePlatformId): string[] {
  const [os, arch] = platform.split("-") as [string, string];
  const keys: string[] = [];
  if (os === "win32") {
    keys.push("windows", "win32", `windows-${arch}`, `win32-${arch}`);
  } else if (os === "macos") {
    keys.push("macos", "darwin", `macos-${arch}`, `darwin-${arch}`);
  } else {
    keys.push(os, `${os}-${arch}`);
  }
  return keys;
}

export function isNativePackageTarget(
  platform: string,
): platform is NativePackageTarget {
  return (NATIVE_PACKAGE_TARGETS as readonly string[]).includes(platform);
}

function parseKind(
  table: Record<string, unknown>,
): NativeArtifactKind | undefined {
  const value = table.kind;
  if (value === undefined) {
    return undefined;
  }
  if (value !== "static" && value !== "dynamic") {
    throw new Error(
      'project.toml: native.kind must be "static" or "dynamic"',
    );
  }
  return value;
}

function parseLink(table: Record<string, unknown>): NativeLinkPreference {
  const value = table.link;
  if (value === undefined) {
    return "auto";
  }
  if (value !== "static" && value !== "dynamic" && value !== "auto") {
    throw new Error(
      'project.toml: native.link must be "static", "dynamic", or "auto"',
    );
  }
  return value;
}

/**
 * Parse all `[native]` and `[native.*]` tables from a project.toml root object.
 */
export function parseNativeConfig(
  table: Record<string, unknown>,
): ParsedNativeConfig {
  const platforms = new Map<string, NativeConfigSection>();
  let base = EMPTY_SECTION;
  let name: string | undefined;
  let version: string | undefined;
  let kind: NativeArtifactKind | undefined;
  let link: NativeLinkPreference = "auto";
  let systemLibraries: string[] = [];

  for (const [key, value] of Object.entries(table)) {
    if (key === "native") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("project.toml: [native] must be a table");
      }
      const nativeTable = value as Record<string, unknown>;
      base = parseNativeSection(nativeTable, "native");
      name = parseOptionalString(nativeTable, "name", "native.name");
      version = parseOptionalString(nativeTable, "version", "native.version");
      kind = parseKind(nativeTable);
      link = parseLink(nativeTable);
      continue;
    }
    if (key === "native.system") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("project.toml: [native.system] must be a table");
      }
      systemLibraries = parseStringArray(
        value as Record<string, unknown>,
        "libraries",
        "native.system.libraries",
      );
      continue;
    }
    if (key.startsWith("native.")) {
      const platformKey = key.slice("native.".length);
      if (!platformKey) {
        throw new Error(`project.toml: invalid native table name '${key}'`);
      }
      if (platformKey === "system") {
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`project.toml: [${key}] must be a table`);
      }
      platforms.set(
        platformKey,
        parseNativeSection(value as Record<string, unknown>, key),
      );
    }
  }

  // smol-toml may nest [native.linux] under native.linux
  if (
    typeof table.native === "object" &&
    table.native !== null &&
    !Array.isArray(table.native)
  ) {
    const nativeTable = table.native as Record<string, unknown>;
    for (const [key, value] of Object.entries(nativeTable)) {
      if (BASE_SCALAR_KEYS.has(key)) {
        continue;
      }
      if (key === "system") {
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        ) {
          systemLibraries = parseStringArray(
            value as Record<string, unknown>,
            "libraries",
            "native.system.libraries",
          );
        }
        continue;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        platforms.set(
          key,
          parseNativeSection(
            value as Record<string, unknown>,
            `native.${key}`,
          ),
        );
      }
    }
  }

  const result: ParsedNativeConfig = {
    base,
    platforms,
    link,
    systemLibraries,
  };
  if (name !== undefined) {
    return {
      ...result,
      name,
      ...(version !== undefined ? { version } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
  }
  if (version !== undefined || kind !== undefined) {
    return {
      ...result,
      ...(version !== undefined ? { version } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
  }
  return result;
}

function candidateLibraryNames(
  lib: string,
  platform: RuntimePlatformId,
  preference: NativeLinkPreference,
): string[] {
  const staticNames: string[] = [];
  const dynamicNames: string[] = [];
  if (platform.startsWith("win32")) {
    staticNames.push(`${lib}.lib`, `lib${lib}.lib`, `lib${lib}.a`);
    dynamicNames.push(`${lib}.dll`, `lib${lib}.dll`);
    // Import library still needed for dynamic on Windows
    dynamicNames.push(`${lib}.lib`, `lib${lib}.lib`);
  } else if (platform.startsWith("macos")) {
    staticNames.push(`lib${lib}.a`, `${lib}.a`);
    dynamicNames.push(`lib${lib}.dylib`, `${lib}.dylib`);
  } else {
    staticNames.push(`lib${lib}.a`, `${lib}.a`);
    dynamicNames.push(`lib${lib}.so`, `${lib}.so`);
  }

  if (preference === "static") {
    return [...staticNames, ...dynamicNames];
  }
  if (preference === "dynamic") {
    return [...dynamicNames, ...staticNames];
  }
  // auto: prefer static for reproducible single-binary builds
  return [...staticNames, ...dynamicNames];
}

function findLibraryFile(
  lib: string,
  searchDirs: readonly string[],
  platform: RuntimePlatformId,
  preference: NativeLinkPreference,
): string | null {
  const names = candidateLibraryNames(lib, platform, preference);
  for (const dir of searchDirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isDynamicLibrary(path: string): boolean {
  return /\.(so|dylib|dll)$/i.test(path);
}

function isStaticLibrary(path: string): boolean {
  return /\.(a|lib)$/i.test(path) && !/\.dll\.lib$/i.test(path);
}

function inferArtifactKind(path: string): NativeArtifactKind {
  if (isDynamicLibrary(path)) {
    return "dynamic";
  }
  return "static";
}

function companionRuntimeLibraries(
  linkFile: string,
  platform: RuntimePlatformId,
): string[] {
  if (isDynamicLibrary(linkFile)) {
    return [linkFile];
  }
  // Windows: linking against foo.lib may need foo.dll beside the binary
  if (platform.startsWith("win32") && linkFile.toLowerCase().endsWith(".lib")) {
    const base = linkFile.replace(/\.lib$/i, "");
    const dll = `${base}.dll`;
    if (existsSync(dll)) {
      return [dll];
    }
    const dir = resolve(linkFile, "..");
    const name = linkFile.split(/[/\\]/).pop()?.replace(/\.lib$/i, "") ?? "";
    const alt = join(dir, `${name}.dll`);
    if (existsSync(alt)) {
      return [alt];
    }
  }
  return [];
}

/**
 * Resolve native link inputs for a project on the given (or host) platform.
 */
export function resolveNativeLinkSpec(
  projectRoot: string,
  config: ParsedNativeConfig,
  platform: RuntimePlatformId = hostRuntimePlatformId(),
  extraSearchDirs: readonly string[] = [],
): NativeLinkSpec {
  const keys = nativePlatformKeys(platform);
  const platformSections = keys
    .map((k) => config.platforms.get(k))
    .filter((s): s is NativeConfigSection => s !== undefined);
  const merged = mergeSections(config.base, ...platformSections);
  const preference: NativeLinkPreference =
    config.link !== "auto"
      ? config.link
      : config.kind === "dynamic"
        ? "dynamic"
        : config.kind === "static"
          ? "static"
          : "auto";

  const searchDirs: string[] = [];
  for (const rel of merged.libraryPaths) {
    searchDirs.push(resolve(projectRoot, rel));
  }
  for (const dir of extraSearchDirs) {
    searchDirs.push(resolve(dir));
  }
  // Conventional package-bundled location
  const bundled = resolve(projectRoot, "native", platform);
  if (existsSync(bundled)) {
    searchDirs.push(bundled);
  }
  // Also try os-only folder e.g. native/linux
  const osOnly = resolve(projectRoot, "native", platform.split("-")[0]!);
  if (existsSync(osOnly) && osOnly !== bundled) {
    searchDirs.push(osOnly);
  }

  const libraryFiles: string[] = [];
  const systemLibraries: string[] = [...config.systemLibraries];
  const runtimeLibraries: string[] = [];
  const usedPaths = new Set<string>();

  if (merged.library) {
    let found: string | null = null;
    for (const dir of searchDirs) {
      const candidate = join(dir, merged.library);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      const atRoot = resolve(projectRoot, merged.library);
      if (existsSync(atRoot)) {
        found = atRoot;
      }
    }
    if (found) {
      libraryFiles.push(found);
      usedPaths.add(resolve(found, ".."));
      runtimeLibraries.push(...companionRuntimeLibraries(found, platform));
    }
  }

  for (const lib of merged.libraries) {
    const found = findLibraryFile(lib, searchDirs, platform, preference);
    if (found) {
      if (!libraryFiles.includes(found)) {
        libraryFiles.push(found);
        usedPaths.add(resolve(found, ".."));
        runtimeLibraries.push(...companionRuntimeLibraries(found, platform));
      }
    } else {
      // Not found as a file — treat as system library unless already listed
      if (!systemLibraries.includes(lib)) {
        systemLibraries.push(lib);
      }
    }
  }

  return {
    libraryFiles,
    libraryPaths: [...new Set([...searchDirs, ...usedPaths])],
    systemLibraries,
    linkArgs: merged.linkArgs,
    headers: merged.headers,
    runtimeLibraries: [...new Set(runtimeLibraries)],
  };
}

/** Merge multiple link specs (root + transitive dependencies). */
export function mergeNativeLinkSpecs(
  ...specs: readonly NativeLinkSpec[]
): NativeLinkSpec {
  return {
    libraryFiles: [...new Set(specs.flatMap((s) => s.libraryFiles))],
    libraryPaths: [...new Set(specs.flatMap((s) => s.libraryPaths))],
    systemLibraries: [...new Set(specs.flatMap((s) => s.systemLibraries))],
    linkArgs: specs.flatMap((s) => s.linkArgs),
    headers: [...new Set(specs.flatMap((s) => s.headers))],
    runtimeLibraries: [...new Set(specs.flatMap((s) => s.runtimeLibraries))],
  };
}

export function emptyNativeLinkSpec(): NativeLinkSpec {
  return {
    libraryFiles: [],
    libraryPaths: [],
    systemLibraries: [],
    linkArgs: [],
    headers: [],
    runtimeLibraries: [],
  };
}

/** List platform dirs present under `native/` that are valid Phase 5 targets. */
export function listBundledNativeTargets(projectRoot: string): string[] {
  const nativeRoot = join(projectRoot, "native");
  if (!existsSync(nativeRoot)) {
    return [];
  }
  const found: string[] = [];
  for (const name of readdirSync(nativeRoot)) {
    const full = join(nativeRoot, name);
    if (!statSync(full).isDirectory()) {
      continue;
    }
    // Normalize windows-* → win32-*
    const normalized =
      name === "windows-x64" || name === "windows-arm64"
        ? name.replace("windows-", "win32-")
        : name;
    if (isNativePackageTarget(normalized)) {
      found.push(normalized);
    }
  }
  return [...new Set(found)].sort();
}

/** Portable rpath arguments so the binary finds local dynlibs without env vars. */
export function portableRpathArgs(
  platform: RuntimePlatformId = hostRuntimePlatformId(),
): string[] {
  if (platform.startsWith("linux")) {
    return ["-rpath", "$ORIGIN"];
  }
  if (platform.startsWith("macos")) {
    return ["-rpath", "@loader_path"];
  }
  return [];
}

export { inferArtifactKind, isDynamicLibrary, isStaticLibrary };
