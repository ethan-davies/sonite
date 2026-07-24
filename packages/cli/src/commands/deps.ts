import {
  formatUpdateChanges,
  installProjectDependencies,
  removeInstalledPackage,
  resolveAndInstall,
  resolveInstallVersion,
  updateProjectDependencies,
  ResolveError,
  NativeResolveError,
} from "../deps/install.js";
import {
  loadLockfile,
  writeLockfile,
} from "../deps/lock.js";
import {
  isValidPackageName,
  parsePackageSpec,
  removeDependency,
  setDependency,
} from "../deps/manifest.js";
import { formatNativeAddReport } from "../deps/native-resolve.js";
import { NativeIntegrityError } from "../deps/native-cache.js";
import { mergeRootDeps } from "../deps/resolve.js";
import { parseVersionRequirement } from "../deps/semver.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";
import {
  formatDeprecationWarning,
  getPackage,
  getVersion,
} from "../registry/packages.js";

function printError(error: unknown): void {
  if (
    error instanceof ResolveError ||
    error instanceof NativeResolveError ||
    error instanceof NativeIntegrityError
  ) {
    console.error(error.message);
    return;
  }
  const message =
    error instanceof ProjectError || error instanceof RegistryError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`error: ${message}`);
}

export async function runAdd(spec: string): Promise<number> {
  try {
    const project = loadProject();
    const { name, version: requested } = parsePackageSpec(spec);
    if (!isValidPackageName(name)) {
      console.error(`error: invalid package name '${name}'`);
      return 1;
    }
    if (requested) {
      parseVersionRequirement(requested);
    }

    const resolved = await resolveInstallVersion(name, requested);
    try {
      const ver = await getVersion(name, resolved.version);
      const pkg = await getPackage(name);
      if (pkg.deprecated) {
        console.warn(
          formatDeprecationWarning(
            name,
            undefined,
            pkg.deprecationReason,
            pkg.replacement,
          ),
        );
      } else if (ver.deprecated) {
        console.warn(
          formatDeprecationWarning(
            name,
            ver.version,
            ver.deprecationReason,
            ver.replacement,
          ),
        );
      }
    } catch {
      // Deprecation lookup is best-effort.
    }
    console.log(`adding ${name}@${resolved.requirement} (resolved ${resolved.version})`);
    setDependency(project, name, resolved.requirement);

    // Full graph resolve so transitive deps and the lockfile stay consistent.
    const refreshed = loadProject(project.root);
    const result = await resolveAndInstall(refreshed);

    console.log(`added ${name}@${resolved.requirement}`);
    const nativeNote = formatNativeAddReport(result.natives);
    if (nativeNote) {
      console.log(nativeNote);
    }
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runRemove(name: string): Promise<number> {
  try {
    const project = loadProject();
    const lock = loadLockfile(project.root);
    const previous = lock?.packages.find((p) => p.name === name);

    removeDependency(project, name);

    // Re-resolve remaining deps (drops transitive packages only needed by `name`).
    const refreshed = loadProject(project.root);
    const { roots } = mergeRootDeps(
      refreshed.dependencies,
      refreshed.devDependencies,
    );
    if (Object.keys(roots).length === 0) {
      if (lock) {
        for (const entry of lock.packages) {
          removeInstalledPackage(project.root, entry.name, entry.version);
        }
      } else if (previous) {
        removeInstalledPackage(project.root, name, previous.version);
      }
      writeLockfile(project.root, [], []);
    } else {
      await resolveAndInstall(refreshed);
    }

    console.log(`removed ${name}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runInstall(): Promise<number> {
  try {
    const project = loadProject();
    const { roots } = mergeRootDeps(
      project.dependencies,
      project.devDependencies,
    );
    if (Object.keys(roots).length === 0) {
      const lock = loadLockfile(project.root);
      if (lock) {
        for (const entry of lock.packages) {
          removeInstalledPackage(project.root, entry.name, entry.version);
        }
      }
      console.log("no dependencies to install");
      writeLockfile(project.root, [], []);
      return 0;
    }
    const installed = await installProjectDependencies(project, {
      report: true,
    });
    console.log(
      `installed ${installed.packages.length} package(s)` +
        (installed.natives.length > 0
          ? `, ${installed.natives.length} native`
          : ""),
    );
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runUpdate(name: string | undefined): Promise<number> {
  try {
    const project = loadProject();
    const { roots } = mergeRootDeps(
      project.dependencies,
      project.devDependencies,
    );
    if (Object.keys(roots).length === 0) {
      console.log("no dependencies to update");
      return 0;
    }
    const installed = await updateProjectDependencies(project, name);
    console.log(formatUpdateChanges(installed.changes));
    console.log("");
    console.log(
      `updated ${installed.packages.length} package(s)` +
        (installed.natives.length > 0
          ? `, ${installed.natives.length} native`
          : ""),
    );
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}
