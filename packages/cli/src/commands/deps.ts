import {
  installProjectDependencies,
  removeInstalledPackage,
  resolveAndInstall,
  resolveInstallVersion,
  updateProjectDependencies,
  ResolveError,
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
import { parseVersionRequirement } from "../deps/semver.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";

function printError(error: unknown): void {
  if (error instanceof ResolveError) {
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
    console.log(`adding ${name}@${resolved.requirement} (resolved ${resolved.version})`);
    setDependency(project, name, resolved.requirement);

    // Full graph resolve so transitive deps and the lockfile stay consistent.
    const refreshed = loadProject(project.root);
    await resolveAndInstall(refreshed);

    console.log(`added ${name}@${resolved.requirement}`);
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
    if (Object.keys(refreshed.dependencies).length === 0) {
      if (lock) {
        for (const entry of lock.packages) {
          removeInstalledPackage(project.root, entry.name, entry.version);
        }
      } else if (previous) {
        removeInstalledPackage(project.root, name, previous.version);
      }
      writeLockfile(project.root, []);
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
    const deps = Object.keys(project.dependencies);
    if (deps.length === 0) {
      const lock = loadLockfile(project.root);
      if (lock) {
        for (const entry of lock.packages) {
          removeInstalledPackage(project.root, entry.name, entry.version);
        }
      }
      console.log("no dependencies to install");
      writeLockfile(project.root, []);
      return 0;
    }
    const installed = await installProjectDependencies(project);
    console.log(`installed ${installed.length} package(s)`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runUpdate(name: string | undefined): Promise<number> {
  try {
    const project = loadProject();
    if (Object.keys(project.dependencies).length === 0) {
      console.log("no dependencies to update");
      return 0;
    }
    const installed = await updateProjectDependencies(project, name);
    console.log(`updated ${installed.length} package(s)`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}
