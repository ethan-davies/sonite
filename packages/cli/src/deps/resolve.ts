import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getRegistryUrl } from "../config.js";
import { listVersions, getVersion } from "../registry/packages.js";
import { RegistryError } from "../registry/client.js";
import {
  parseDepSpec,
  ProjectError,
  resolveDepPath,
} from "../project.js";
import {
  parseVersionRequirement,
  versionSatisfies,
  versionsMatchingAll,
  type VersionRequirement,
} from "./semver.js";
import {
  isPackageVersionInstalled,
  packageVersionPath,
} from "./store.js";
import { installPackageVersion } from "./install-fetch.js";
import {
  isPathDep,
  isVersionDep,
  pathLockSource,
  type DepSpec,
} from "./types.js";

export interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
  readonly checksum: string;
  readonly source: string;
  readonly dependencies: readonly string[];
  /** True when this package was forced by a root `[overrides]` entry. */
  readonly override?: boolean;
  /** True when only reachable via `[dev-dependencies]`. */
  readonly dev?: boolean;
  /** Publisher username when known from the registry. */
  readonly publishedBy?: string;
  /** ISO publish timestamp when known. */
  readonly publishedAt?: string;
}

export interface ResolveResult {
  readonly packages: readonly ResolvedPackage[];
}

export interface ResolveOptions {
  /**
   * Preferred locked versions. When a preferred version still satisfies all
   * constraints and the package is not in `float`, it is kept instead of the
   * highest matching version.
   */
  readonly prefer?: ReadonlyMap<string, string>;
  /** Package names that should ignore lock preferences and float to highest match. */
  readonly float?: ReadonlySet<string>;
  /** Exact versions forced by `[overrides]`. */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Root package names that come from `[dev-dependencies]` only (not also
   * in production dependencies). Used to mark the reachable subgraph as `dev`.
   */
  readonly devRootNames?: ReadonlySet<string>;
  /** Production root names (for computing which packages are production). */
  readonly productionRootNames?: ReadonlySet<string>;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface Constraint {
  readonly range: VersionRequirement;
  readonly requiredBy: string;
  readonly requiredByVersion?: string;
}

interface Selected {
  version: string;
  checksum: string;
  source: string;
  /** name → requirement from that package's project.toml */
  dependencies: Record<string, DepSpec>;
  override?: boolean;
  publishedBy?: string;
  publishedAt?: string;
  /** Absolute path for path dependencies. */
  pathRoot?: string;
}

/**
 * Resolve the full dependency graph for root requirements from project.toml.
 * One version per package name. Rebuilds constraints each round from the
 * currently selected graph so parent reselection cannot leave stale ranges.
 */
export async function resolveDependencies(
  projectRoot: string,
  rootDeps: Readonly<Record<string, DepSpec>>,
  opts?: ResolveOptions,
): Promise<ResolveResult> {
  const prefer = opts?.prefer;
  const float = opts?.float ?? new Set<string>();
  const overrides = opts?.overrides ?? {};
  const registrySource = getRegistryUrl();

  const rootVersionReqs = new Map<string, VersionRequirement>();
  const rootPathSpecs = new Map<string, string>();

  for (const [name, spec] of Object.entries(rootDeps)) {
    if (spec.kind === "version") {
      try {
        rootVersionReqs.set(name, parseVersionRequirement(spec.range));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ResolveError(`dependency '${name}': ${message}`);
      }
    } else {
      rootPathSpecs.set(name, spec.path);
    }
  }

  const selected = new Map<string, Selected>();
  const versionCache = new Map<string, string[]>();

  async function versionsOf(name: string): Promise<string[]> {
    const cached = versionCache.get(name);
    if (cached) {
      return cached;
    }
    try {
      const listed = await listVersions(name);
      const versions = listed.versions.map((v) => v.version);
      versionCache.set(name, versions);
      return versions;
    } catch (error) {
      if (error instanceof RegistryError && error.status === 404) {
        throw new ResolveError(`package '${name}' not found on the registry`);
      }
      throw error;
    }
  }

  // Seed path roots immediately.
  for (const [name, pathSpec] of rootPathSpecs) {
    const loaded = loadPathPackage(projectRoot, name, pathSpec);
    selected.set(name, loaded);
  }

  // Seed version roots.
  for (const name of rootVersionReqs.keys()) {
    if (!selected.has(name)) {
      selected.set(name, {
        version: "",
        checksum: "",
        source: registrySource,
        dependencies: {},
      });
    }
  }

  const maxRounds = 64;
  for (let round = 0; round < maxRounds; round++) {
    const constraints = collectConstraints(rootVersionReqs, selected);
    let changed = false;

    // Discover new path deps from selected packages.
    for (const [, sel] of selected) {
      if (!sel.version && !sel.pathRoot) {
        continue;
      }
      for (const [depName, depSpec] of Object.entries(sel.dependencies)) {
        if (isPathDep(depSpec) && !selected.has(depName)) {
          const base = sel.pathRoot ?? projectRoot;
          const loaded = loadPathPackage(base, depName, depSpec.path);
          selected.set(depName, loaded);
          changed = true;
        }
      }
    }

    // Packages that appear in version constraints must be selected.
    for (const name of constraints.keys()) {
      if (!selected.has(name)) {
        selected.set(name, {
          version: "",
          checksum: "",
          source: registrySource,
          dependencies: {},
        });
        changed = true;
      }
    }

    // Drop packages no longer constrained (unreachable), except path roots.
    const reachable = new Set<string>([
      ...rootVersionReqs.keys(),
      ...rootPathSpecs.keys(),
    ]);
    // Walk from roots through selected deps.
    const queue = [...reachable];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      const sel = selected.get(cur);
      if (!sel) continue;
      for (const dep of Object.keys(sel.dependencies)) {
        if (!reachable.has(dep)) {
          reachable.add(dep);
          queue.push(dep);
        }
      }
      // Also ensure constraint names stay.
      for (const name of constraints.keys()) {
        reachable.add(name);
      }
    }

    for (const name of [...selected.keys()]) {
      if (!reachable.has(name) && !rootPathSpecs.has(name)) {
        selected.delete(name);
        changed = true;
      }
    }

    for (const [name, reqs] of constraints) {
      const existing = selected.get(name);
      // Path packages are not re-resolved via the registry.
      if (existing?.pathRoot) {
        continue;
      }

      const overrideVersion = overrides[name];
      if (overrideVersion) {
        validateOverride(name, overrideVersion, reqs);
        const available = await versionsOf(name);
        if (!available.includes(overrideVersion)) {
          throw new ResolveError(
            formatOverrideMissing(name, overrideVersion, available),
          );
        }
        const current = selected.get(name);
        if (
          current &&
          current.version === overrideVersion &&
          current.checksum &&
          current.override
        ) {
          continue;
        }
        const loaded = await loadPackageManifest(
          projectRoot,
          name,
          overrideVersion,
        );
        selected.set(name, {
          version: overrideVersion,
          checksum: loaded.checksum,
          source: registrySource,
          dependencies: loaded.dependencies,
          override: true,
          ...(loaded.publishedBy !== undefined
            ? { publishedBy: loaded.publishedBy }
            : {}),
          ...(loaded.publishedAt !== undefined
            ? { publishedAt: loaded.publishedAt }
            : {}),
        });
        changed = true;
        continue;
      }

      const available = await versionsOf(name);
      if (available.length === 0) {
        throw new ResolveError(`package '${name}' has no published versions`);
      }
      const matching = versionsMatchingAll(
        available,
        reqs.map((c) => c.range),
      );
      if (matching.length === 0) {
        throw new ResolveError(formatConflict(name, reqs));
      }

      const chosen = pickVersion(name, matching, prefer, float);
      const current = selected.get(name);
      if (current && current.version === chosen && current.checksum) {
        continue;
      }

      const loaded = await loadPackageManifest(projectRoot, name, chosen);
      selected.set(name, {
        version: chosen,
        checksum: loaded.checksum,
        source: registrySource,
        dependencies: loaded.dependencies,
        ...(loaded.publishedBy !== undefined
          ? { publishedBy: loaded.publishedBy }
          : {}),
        ...(loaded.publishedAt !== undefined
          ? { publishedAt: loaded.publishedAt }
          : {}),
      });
      changed = true;
    }

    if (!changed) {
      break;
    }
    if (round === maxRounds - 1) {
      const cycle = findDependencyCycle(selected);
      if (cycle) {
        throw new ResolveError(
          `dependency resolution did not converge\ncycle: ${cycle.join(" -> ")}`,
        );
      }
      throw new ResolveError("dependency resolution did not converge");
    }
  }

  const productionReachable = computeReachable(
    selected,
    opts?.productionRootNames ??
      new Set(Object.keys(rootDeps).filter((n) => !opts?.devRootNames?.has(n))),
  );

  const packages: ResolvedPackage[] = [...selected.entries()]
    .map(([name, s]) => {
      const pkg: ResolvedPackage = {
        name,
        version: s.version,
        checksum: s.checksum,
        source: s.source || registrySource,
        dependencies: Object.keys(s.dependencies).sort(),
      };
      const withFlags: {
        -readonly [K in keyof ResolvedPackage]: ResolvedPackage[K];
      } = { ...pkg };
      if (s.override) {
        withFlags.override = true;
      }
      if (!productionReachable.has(name)) {
        withFlags.dev = true;
      }
      if (s.publishedBy) {
        withFlags.publishedBy = s.publishedBy;
      }
      if (s.publishedAt) {
        withFlags.publishedAt = s.publishedAt;
      }
      return withFlags;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const pkg of packages) {
    if (!pkg.version || !pkg.checksum) {
      throw new ResolveError(`failed to select a version for '${pkg.name}'`);
    }
  }

  return { packages };
}

function computeReachable(
  selected: ReadonlyMap<string, Selected>,
  roots: ReadonlySet<string>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [...roots].filter((n) => selected.has(n));
  for (const r of queue) {
    reachable.add(r);
  }
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const sel = selected.get(cur);
    if (!sel) continue;
    for (const dep of Object.keys(sel.dependencies)) {
      if (!reachable.has(dep) && selected.has(dep)) {
        reachable.add(dep);
        queue.push(dep);
      }
    }
  }
  return reachable;
}

function validateOverride(
  name: string,
  overrideVersion: string,
  constraints: readonly Constraint[],
): void {
  for (const c of constraints) {
    if (!versionSatisfies(overrideVersion, c.range)) {
      throw new ResolveError(formatOverrideConflict(name, overrideVersion, c));
    }
  }
}

/** Exported for unit tests. */
export function formatOverrideConflict(
  name: string,
  overrideVersion: string,
  constraint: Constraint,
): string {
  const requiredBy =
    constraint.requiredBy === "project"
      ? "project"
      : constraint.requiredByVersion
        ? `${constraint.requiredBy}`
        : constraint.requiredBy;
  return [
    "Dependency override conflict:",
    "",
    `  Package: ${name}`,
    `  Requested override: ${overrideVersion}`,
    "",
    `  ${requiredBy} requires: ${constraint.range.raw}`,
    "",
    "The override is incompatible with the dependency constraints.",
  ].join("\n");
}

function formatOverrideMissing(
  name: string,
  overrideVersion: string,
  available: readonly string[],
): string {
  return [
    `Dependency override for '${name}' requests ${overrideVersion},`,
    `but that version is not published on the registry.`,
    available.length
      ? `Available: ${available.slice(0, 8).join(", ")}${available.length > 8 ? ", ..." : ""}`
      : "No versions are available.",
  ].join("\n");
}

/** Exported for unit tests — prefer locked version when still valid and not floating. */
export function pickVersion(
  name: string,
  matchingHighestFirst: readonly string[],
  prefer: ReadonlyMap<string, string> | undefined,
  float: ReadonlySet<string>,
): string {
  const highest = matchingHighestFirst[0]!;
  if (!prefer || float.has(name)) {
    return highest;
  }
  const preferred = prefer.get(name);
  if (preferred && matchingHighestFirst.includes(preferred)) {
    return preferred;
  }
  return highest;
}

/**
 * Find a dependency cycle among selected packages with versions.
 * Returns a path like `["a", "b", "a"]` or null if none.
 */
export function findDependencyCycle(
  selected: ReadonlyMap<string, { dependencies: Record<string, DepSpec | string> }>,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(name: string): string[] | null {
    if (visited.has(name)) {
      return null;
    }
    if (visiting.has(name)) {
      const idx = stack.indexOf(name);
      return [...stack.slice(idx), name];
    }
    visiting.add(name);
    stack.push(name);
    const deps = selected.get(name)?.dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      if (!selected.has(dep)) {
        continue;
      }
      const cycle = dfs(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  }

  for (const name of selected.keys()) {
    const cycle = dfs(name);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function collectConstraints(
  rootRequirements: ReadonlyMap<string, VersionRequirement>,
  selected: ReadonlyMap<string, Selected>,
): Map<string, Constraint[]> {
  const out = new Map<string, Constraint[]>();

  function add(name: string, constraint: Constraint): void {
    const list = out.get(name) ?? [];
    list.push(constraint);
    out.set(name, list);
  }

  for (const [name, req] of rootRequirements) {
    add(name, { range: req, requiredBy: "project" });
  }

  for (const [parent, sel] of selected) {
    if (!sel.version) {
      continue;
    }
    for (const [depName, depSpec] of Object.entries(sel.dependencies)) {
      if (!isVersionDep(depSpec)) {
        continue;
      }
      let req: VersionRequirement;
      try {
        req = parseVersionRequirement(depSpec.range);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ResolveError(
          `${parent}@${sel.version} has invalid dependency '${depName}': ${message}`,
        );
      }
      add(depName, {
        range: req,
        requiredBy: parent,
        requiredByVersion: sel.version,
      });
    }
  }

  return out;
}

/** Exported for unit tests — human-readable incompatible-range report. */
export function formatConflict(
  name: string,
  constraints: readonly Constraint[],
): string {
  const lines = ["Could not resolve dependencies.", ""];
  for (const c of constraints) {
    if (c.requiredBy === "project") {
      lines.push("project requires:");
      lines.push(`  ${name} ${c.range.raw}`);
      lines.push("");
    } else {
      const ver = c.requiredByVersion ? ` ${c.requiredByVersion}` : "";
      lines.push(`${c.requiredBy}${ver} requires:`);
      lines.push(`  ${name} ${c.range.raw}`);
      lines.push("");
    }
  }
  lines.push(`No compatible version of ${name} exists.`);
  return lines.join("\n");
}

function loadPathPackage(
  fromRoot: string,
  expectedName: string,
  pathSpec: string,
): Selected {
  const absolute = resolveDepPath(fromRoot, pathSpec);
  const manifestPath = join(absolute, "project.toml");
  if (!existsSync(manifestPath)) {
    throw new ResolveError(
      `path dependency '${expectedName}' not found at ${absolute} (missing project.toml)`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResolveError(
      `failed to parse project.toml for path dependency '${expectedName}': ${message}`,
    );
  }
  const pkg = raw.package;
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    throw new ResolveError(
      `path dependency '${expectedName}' at ${absolute}: missing [package]`,
    );
  }
  const pkgTable = pkg as Record<string, unknown>;
  const name = pkgTable.name;
  const version = pkgTable.version;
  if (typeof name !== "string" || !name.trim()) {
    throw new ResolveError(
      `path dependency at ${absolute}: package.name must be a non-empty string`,
    );
  }
  if (name !== expectedName) {
    throw new ResolveError(
      `path dependency '${expectedName}' at ${absolute}: package.name is '${name}' (names must match)`,
    );
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new ResolveError(
      `path dependency '${expectedName}' at ${absolute}: package.version must be a non-empty string`,
    );
  }

  const checksum = createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex");

  return {
    version: version.trim(),
    checksum,
    source: pathLockSource(absolute),
    dependencies: readDependenciesFromTable(raw, `${expectedName}@${version}`),
    pathRoot: absolute,
  };
}

async function loadPackageManifest(
  projectRoot: string,
  name: string,
  version: string,
): Promise<{
  checksum: string;
  dependencies: Record<string, DepSpec>;
  publishedBy?: string;
  publishedAt?: string;
}> {
  let checksum: string;
  let publishedBy: string | undefined;
  let publishedAt: string | undefined;
  if (!isPackageVersionInstalled(name, version)) {
    const installed = await installPackageVersion(projectRoot, name, version);
    checksum = installed.checksum;
  } else {
    const meta = await getVersion(name, version);
    checksum = meta.checksumSha256;
    publishedBy = meta.publishedBy?.username;
    publishedAt = meta.createdAt;
    await installPackageVersion(projectRoot, name, version, checksum);
  }

  // Prefer provenance from registry when available.
  try {
    const meta = await getVersion(name, version);
    publishedBy = meta.publishedBy?.username;
    publishedAt = meta.createdAt;
  } catch {
    // ignore — install already succeeded
  }

  return {
    checksum,
    dependencies: readPackageDependencies(name, version),
    ...(publishedBy !== undefined ? { publishedBy } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

export function readPackageDependencies(
  name: string,
  version: string,
): Record<string, DepSpec> {
  const manifestPath = join(packageVersionPath(name, version), "project.toml");
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    const raw = parseToml(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    return readDependenciesFromTable(raw, `${name}@${version}`);
  } catch (error) {
    if (error instanceof ProjectError || error instanceof ResolveError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ResolveError(
      `failed to read dependencies for ${name}@${version}: ${message}`,
    );
  }
}

function readDependenciesFromTable(
  raw: Record<string, unknown>,
  label: string,
): Record<string, DepSpec> {
  const deps = raw.dependencies;
  if (deps === undefined) {
    return {};
  }
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    throw new ProjectError(`${label}: invalid [dependencies] in project.toml`);
  }
  const out: Record<string, DepSpec> = {};
  for (const [key, value] of Object.entries(deps)) {
    try {
      out[key] = parseDepSpec("dependencies", key, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProjectError(`${label}: ${message}`);
    }
  }
  return out;
}

export function lockSatisfiesRoots(
  rootDeps: Readonly<Record<string, DepSpec>>,
  locked: ReadonlyMap<
    string,
    { version: string; source: string }
  >,
): boolean {
  for (const [name, spec] of Object.entries(rootDeps)) {
    const entry = locked.get(name);
    if (!entry) {
      return false;
    }
    if (spec.kind === "path") {
      const expected = pathLockSource(resolveDepPath(resolve("."), spec.path));
      // Path check is approximate here; install.ts does a proper check with project root.
      if (!entry.source.startsWith("path:")) {
        return false;
      }
      void expected;
      continue;
    }
    try {
      const req = parseVersionRequirement(spec.range);
      if (!versionsMatchingAll([entry.version], [req]).length) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Check that locked packages still satisfy root deps for a known project root. */
export function lockSatisfiesRootsAt(
  projectRoot: string,
  rootDeps: Readonly<Record<string, DepSpec>>,
  locked: ReadonlyMap<string, { version: string; source: string }>,
): boolean {
  for (const [name, spec] of Object.entries(rootDeps)) {
    const entry = locked.get(name);
    if (!entry) {
      return false;
    }
    if (spec.kind === "path") {
      const expected = pathLockSource(resolveDepPath(projectRoot, spec.path));
      if (entry.source !== expected) {
        return false;
      }
      continue;
    }
    try {
      const req = parseVersionRequirement(spec.range);
      if (!versionsMatchingAll([entry.version], [req]).length) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Merge production + dev dependency maps for resolution. */
export function mergeRootDeps(
  dependencies: Readonly<Record<string, DepSpec>>,
  devDependencies: Readonly<Record<string, DepSpec>>,
): {
  roots: Record<string, DepSpec>;
  productionRootNames: Set<string>;
  devRootNames: Set<string>;
} {
  const roots: Record<string, DepSpec> = { ...dependencies };
  const productionRootNames = new Set(Object.keys(dependencies));
  const devRootNames = new Set<string>();
  for (const [name, spec] of Object.entries(devDependencies)) {
    if (!(name in roots)) {
      roots[name] = spec;
      devRootNames.add(name);
    }
  }
  return { roots, productionRootNames, devRootNames };
}
