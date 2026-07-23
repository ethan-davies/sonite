import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getRegistryUrl } from "../config.js";
import { listVersions, getVersion } from "../registry/packages.js";
import { RegistryError } from "../registry/client.js";
import { ProjectError } from "../project.js";
import {
  parseVersionRequirement,
  versionsMatchingAll,
  type VersionRequirement,
} from "./semver.js";
import {
  isPackageVersionInstalled,
  packageVersionPath,
} from "./store.js";
import { installPackageVersion } from "./install-fetch.js";

export interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
  readonly checksum: string;
  readonly source: string;
  readonly dependencies: readonly string[];
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
  /** name → requirement string from that package's project.toml */
  dependencies: Record<string, string>;
}

/**
 * Resolve the full dependency graph for root requirements from project.toml.
 * One version per package name. Rebuilds constraints each round from the
 * currently selected graph so parent reselection cannot leave stale ranges.
 */
export async function resolveDependencies(
  projectRoot: string,
  rootDeps: Readonly<Record<string, string>>,
  opts?: ResolveOptions,
): Promise<ResolveResult> {
  const prefer = opts?.prefer;
  const float = opts?.float ?? new Set<string>();
  const registrySource = getRegistryUrl();

  const rootRequirements = new Map<string, VersionRequirement>();
  for (const [name, raw] of Object.entries(rootDeps)) {
    try {
      rootRequirements.set(name, parseVersionRequirement(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ResolveError(`dependency '${name}': ${message}`);
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

  // Seed: ensure every root package is considered.
  for (const name of rootRequirements.keys()) {
    selected.set(name, {
      version: "",
      checksum: "",
      source: registrySource,
      dependencies: {},
    });
  }

  const maxRounds = 64;
  for (let round = 0; round < maxRounds; round++) {
    const constraints = collectConstraints(rootRequirements, selected);
    let changed = false;

    // Packages that appear in constraints must be selected.
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

    // Drop packages no longer constrained (unreachable).
    for (const name of [...selected.keys()]) {
      if (!constraints.has(name)) {
        selected.delete(name);
        changed = true;
      }
    }

    for (const [name, reqs] of constraints) {
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

  const packages: ResolvedPackage[] = [...selected.entries()]
    .map(([name, s]) => ({
      name,
      version: s.version,
      checksum: s.checksum,
      source: s.source || registrySource,
      dependencies: Object.keys(s.dependencies).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const pkg of packages) {
    if (!pkg.version || !pkg.checksum) {
      throw new ResolveError(`failed to select a version for '${pkg.name}'`);
    }
  }

  return { packages };
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
  selected: ReadonlyMap<string, { dependencies: Record<string, string> }>,
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
    for (const [depName, depRange] of Object.entries(sel.dependencies)) {
      let req: VersionRequirement;
      try {
        req = parseVersionRequirement(depRange);
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

async function loadPackageManifest(
  projectRoot: string,
  name: string,
  version: string,
): Promise<{ checksum: string; dependencies: Record<string, string> }> {
  let checksum: string;
  if (!isPackageVersionInstalled(name, version)) {
    const installed = await installPackageVersion(projectRoot, name, version);
    checksum = installed.checksum;
  } else {
    const meta = await getVersion(name, version);
    checksum = meta.checksumSha256;
    await installPackageVersion(projectRoot, name, version, checksum);
  }

  return {
    checksum,
    dependencies: readPackageDependencies(name, version),
  };
}

export function readPackageDependencies(
  name: string,
  version: string,
): Record<string, string> {
  const manifestPath = join(packageVersionPath(name, version), "project.toml");
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    const raw = parseToml(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const deps = raw.dependencies;
    if (deps === undefined) {
      return {};
    }
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
      throw new ProjectError(
        `${name}@${version}: invalid [dependencies] in project.toml`,
      );
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(deps)) {
      if (typeof value !== "string" || !value.trim()) {
        throw new ProjectError(
          `${name}@${version}: dependencies.${key} must be a non-empty string`,
        );
      }
      parseVersionRequirement(value);
      out[key] = value.trim();
    }
    return out;
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

export function lockSatisfiesRoots(
  rootDeps: Readonly<Record<string, string>>,
  locked: ReadonlyMap<string, { version: string }>,
): boolean {
  for (const [name, raw] of Object.entries(rootDeps)) {
    const entry = locked.get(name);
    if (!entry) {
      return false;
    }
    try {
      const req = parseVersionRequirement(raw);
      if (!versionsMatchingAll([entry.version], [req]).length) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
