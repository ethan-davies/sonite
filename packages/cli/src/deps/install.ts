import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.js";
import {
  getPackage,
  getVersion,
  listVersions,
} from "../registry/packages.js";
import { installPackageVersion } from "./install-fetch.js";
import {
  loadLockfile,
  lockPackageMap,
  writeLockfile,
  type LockNative,
  type LockPackage,
} from "./lock.js";
import {
  formatNativeInstallReport,
  installNativeArtifacts,
  NativeResolveError,
  resolveNativeArtifacts,
} from "./native-resolve.js";
import {
  lockSatisfiesRootsAt,
  mergeRootDeps,
  resolveDependencies,
  ResolveError,
} from "./resolve.js";
import {
  caretOf,
  maxSatisfying,
  parseVersionRequirement,
} from "./semver.js";
import {
  packageVersionPath,
  removeDependant,
  releasePreviousVersion,
} from "./store.js";
import {
  isPathLockSource,
  pathFromLockSource,
  type DepSpec,
} from "./types.js";

export { installPackageVersion } from "./install-fetch.js";
export { ResolveError } from "./resolve.js";
export { NativeResolveError } from "./native-resolve.js";

function finalizeNativeLock(
  project: Project,
  packages: readonly LockPackage[],
  previousNatives?: readonly LockNative[],
): LockNative[] {
  const artifacts = resolveNativeArtifacts(packages, undefined, {
    packageRootFor: (name, version) => {
      const pkg = packages.find(
        (p) => p.name === name && p.version === version,
      );
      if (pkg && isPathLockSource(pkg.source)) {
        return pathFromLockSource(pkg.source);
      }
      return packageVersionPath(name, version);
    },
  });
  return installNativeArtifacts(artifacts, previousNatives);
}

function toLockPackage(p: {
  name: string;
  version: string;
  checksum: string;
  source: string;
  dependencies: readonly string[];
  override?: boolean;
  dev?: boolean;
  publishedBy?: string;
  publishedAt?: string;
}): LockPackage {
  const pkg: {
    name: string;
    version: string;
    checksum: string;
    source: string;
    dependencies: readonly string[];
    override?: boolean;
    dev?: boolean;
    publishedBy?: string;
    publishedAt?: string;
  } = {
    name: p.name,
    version: p.version,
    checksum: p.checksum,
    source: p.source,
    dependencies: p.dependencies,
  };
  if (p.override) pkg.override = true;
  if (p.dev) pkg.dev = true;
  if (p.publishedBy) pkg.publishedBy = p.publishedBy;
  if (p.publishedAt) pkg.publishedAt = p.publishedAt;
  return pkg;
}

export async function resolveInstallVersion(
  name: string,
  requested: string | undefined,
): Promise<{ requirement: string; version: string; checksum: string }> {
  if (requested) {
    const req = parseVersionRequirement(requested);
    if (req.kind === "exact") {
      const ver = await getVersion(name, req.raw);
      return {
        requirement: req.raw,
        version: ver.version,
        checksum: ver.checksumSha256,
      };
    }
    const listed = await listVersions(name);
    const versions = listed.versions.map((v) => v.version);
    const version = maxSatisfying(versions, req);
    if (!version) {
      throw new ResolveError(
        `no version of '${name}' satisfies '${requested}'`,
      );
    }
    const ver = await getVersion(name, version);
    return {
      requirement: req.raw,
      version: ver.version,
      checksum: ver.checksumSha256,
    };
  }

  const pkg = await getPackage(name);
  if (!pkg.latestVersion) {
    throw new ResolveError(`package '${name}' has no published versions`);
  }
  const version = pkg.latestVersion.version;
  return {
    requirement: caretOf(version),
    version,
    checksum: pkg.latestVersion.checksumSha256,
  };
}

function allRootDeps(project: Project): {
  roots: Record<string, DepSpec>;
  productionRootNames: Set<string>;
  devRootNames: Set<string>;
} {
  return mergeRootDeps(project.dependencies, project.devDependencies);
}

/**
 * Resolve from project.toml (ignoring lock), write project.lock, install everything.
 */
export async function resolveAndInstall(
  project: Project,
  opts?: {
    prefer?: ReadonlyMap<string, string>;
    float?: ReadonlySet<string>;
    /** When true, print the Sonite/Native install report. */
    report?: boolean;
  },
): Promise<{ packages: readonly LockPackage[]; natives: readonly LockNative[] }> {
  const { roots, productionRootNames, devRootNames } = allRootDeps(project);
  const resolved = await resolveDependencies(project.root, roots, {
    ...opts,
    overrides: project.overrides,
    productionRootNames,
    devRootNames,
  });
  const packages: LockPackage[] = resolved.packages.map(toLockPackage);

  const previousLock = loadLockfile(project.root);
  const previous = lockPackageMap(previousLock);
  const nextNames = new Set(packages.map((p) => p.name));
  for (const [name, entry] of previous) {
    if (!nextNames.has(name) && !isPathLockSource(entry.source)) {
      removeDependant(name, entry.version, project.root);
    }
  }

  for (const pkg of packages) {
    if (isPathLockSource(pkg.source)) {
      continue;
    }
    await installPackageVersion(
      project.root,
      pkg.name,
      pkg.version,
      pkg.checksum,
    );
  }

  const natives = finalizeNativeLock(
    project,
    packages,
    previousLock?.natives,
  );
  writeLockfile(project.root, packages, natives);

  if (opts?.report) {
    console.log(formatNativeInstallReport(packages, natives));
  }

  return { packages, natives };
}

/**
 * Install from project.lock when it still satisfies project.toml ranges;
 * otherwise re-resolve.
 */
export async function installProjectDependencies(
  project: Project,
  opts?: { report?: boolean },
): Promise<{ packages: readonly LockPackage[]; natives: readonly LockNative[] }> {
  const lock = loadLockfile(project.root);
  const locked = lockPackageMap(lock);
  const { roots } = allRootDeps(project);

  if (Object.keys(roots).length === 0) {
    for (const [name, entry] of locked) {
      if (!isPathLockSource(entry.source)) {
        removeDependant(name, entry.version, project.root);
      }
    }
    writeLockfile(project.root, [], []);
    return { packages: [], natives: [] };
  }

  if (
    lock &&
    lock.packages.length > 0 &&
    lockSatisfiesRootsAt(project.root, roots, locked)
  ) {
    const nextNames = new Set(lock.packages.map((p) => p.name));
    for (const [name, entry] of locked) {
      if (!nextNames.has(name) && !isPathLockSource(entry.source)) {
        removeDependant(name, entry.version, project.root);
      }
    }

    for (const pkg of lock.packages) {
      if (isPathLockSource(pkg.source)) {
        const pathRoot = pathFromLockSource(pkg.source);
        if (!existsSync(join(pathRoot, "project.toml"))) {
          throw new ResolveError(
            `path dependency '${pkg.name}' missing at ${pathRoot}`,
          );
        }
        if (!opts?.report) {
          console.log(`using path ${pkg.name}@${pkg.version} (${pathRoot})`);
        }
        continue;
      }
      const cached = existsSync(
        join(packageVersionPath(pkg.name, pkg.version), "project.toml"),
      );
      if (!opts?.report) {
        console.log(
          cached
            ? `using cached ${pkg.name}@${pkg.version}`
            : `installing ${pkg.name}@${pkg.version}`,
        );
      }
      await installPackageVersion(
        project.root,
        pkg.name,
        pkg.version,
        pkg.checksum,
      );
    }

    const natives = finalizeNativeLock(project, lock.packages, lock.natives);
    writeLockfile(project.root, lock.packages, natives);

    if (opts?.report) {
      console.log(formatNativeInstallReport(lock.packages, natives));
    }

    return { packages: lock.packages, natives };
  }

  console.log("resolving dependencies");
  return resolveAndInstall(
    project,
    opts?.report ? { report: true } : undefined,
  );
}

export interface UpdateDiff {
  readonly name: string;
  readonly from: string | null;
  readonly to: string;
}

/**
 * Re-resolve dependencies from project.toml ranges and refresh the lockfile.
 *
 * When `only` is set, keep locked versions for other packages when they still
 * satisfy constraints; float `only` to the highest matching version.
 */
export async function updateProjectDependencies(
  project: Project,
  only?: string,
): Promise<{
  packages: readonly LockPackage[];
  natives: readonly LockNative[];
  changes: readonly UpdateDiff[];
}> {
  const { roots } = allRootDeps(project);
  if (only && !(only in roots)) {
    throw new ResolveError(
      `dependency '${only}' is not in project.toml (dependencies or dev-dependencies)`,
    );
  }

  const previous = lockPackageMap(loadLockfile(project.root));
  let result: {
    packages: readonly LockPackage[];
    natives: readonly LockNative[];
  };

  if (!only) {
    console.log("updating dependencies");
    result = await resolveAndInstall(project, { report: true });
  } else {
    const prefer = new Map<string, string>();
    for (const [name, pkg] of previous) {
      prefer.set(name, pkg.version);
    }
    console.log(`updating ${only}`);
    result = await resolveAndInstall(project, {
      prefer,
      float: new Set([only]),
      report: true,
    });
  }

  const changes: UpdateDiff[] = [];
  const nextNames = new Set(result.packages.map((p) => p.name));
  for (const pkg of result.packages) {
    const prev = previous.get(pkg.name);
    if (!prev) {
      changes.push({ name: pkg.name, from: null, to: pkg.version });
    } else if (prev.version !== pkg.version) {
      changes.push({ name: pkg.name, from: prev.version, to: pkg.version });
    }
  }
  for (const [name, prev] of previous) {
    if (!nextNames.has(name)) {
      changes.push({ name, from: prev.version, to: "(removed)" });
    }
  }
  changes.sort((a, b) => a.name.localeCompare(b.name));

  return { ...result, changes };
}

export function removeInstalledPackage(
  projectRoot: string,
  name: string,
  version?: string,
): void {
  if (version) {
    removeDependant(name, version, projectRoot);
    return;
  }
  const lock = loadLockfile(projectRoot);
  const entry = lockPackageMap(lock).get(name);
  if (entry) {
    if (!isPathLockSource(entry.source)) {
      removeDependant(name, entry.version, projectRoot);
    }
    return;
  }
  releasePreviousVersion(name, null, projectRoot);
}

/** Map package names → package roots for this project's lockfile. */
export function discoverInstalledPackages(
  project: Project,
): Map<string, { dir: string; version: string }> {
  const map = new Map<string, { dir: string; version: string }>();
  const lock = lockPackageMap(loadLockfile(project.root));

  for (const [name, entry] of lock) {
    const dir = isPathLockSource(entry.source)
      ? pathFromLockSource(entry.source)
      : packageVersionPath(name, entry.version);
    if (existsSync(join(dir, "project.toml"))) {
      map.set(name, { dir, version: entry.version });
    }
  }
  return map;
}

/** Format update version diffs for CLI output. */
export function formatUpdateChanges(changes: readonly UpdateDiff[]): string {
  if (changes.length === 0) {
    return "No dependency versions changed.";
  }
  const lines = ["Updated dependencies:", ""];
  for (const c of changes) {
    if (c.from === null) {
      lines.push(`${c.name} (new) → ${c.to}`);
    } else if (c.to === "(removed)") {
      lines.push(`${c.name} ${c.from} → (removed)`);
    } else {
      lines.push(`${c.name} ${c.from} → ${c.to}`);
    }
  }
  return lines.join("\n");
}
