import { RegistryError } from "../registry/client.js";
import {
  addMaintainer,
  deprecatePackage,
  deprecatePackageVersion,
  listMaintainers,
  removeMaintainer,
  transferOwnership,
} from "../registry/packages.js";
import { parsePackageSpec } from "../deps/manifest.js";

function printError(error: unknown): void {
  const message =
    error instanceof RegistryError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`error: ${message}`);
}

export async function runOwnerList(name: string): Promise<number> {
  try {
    const result = await listMaintainers(name);
    console.log(`package: ${result.name}`);
    for (const m of result.maintainers) {
      console.log(`  ${m.username} (${m.role})`);
    }
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runOwnerAdd(
  name: string,
  username: string,
): Promise<number> {
  try {
    await addMaintainer(name, username, "maintainer");
    console.log(`added maintainer ${username} to ${name}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runOwnerRemove(
  name: string,
  username: string,
): Promise<number> {
  try {
    await removeMaintainer(name, username);
    console.log(`removed maintainer ${username} from ${name}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runOwnerTransfer(
  name: string,
  username: string,
): Promise<number> {
  try {
    await transferOwnership(name, username);
    console.log(`transferred ownership of ${name} to ${username}`);
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}

export async function runDeprecate(
  spec: string,
  options: { reason: string; replacement?: string },
): Promise<number> {
  try {
    if (!options.reason.trim()) {
      console.error("error: --reason is required");
      return 1;
    }
    const { name, version } = parsePackageSpec(spec);
    if (version) {
      await deprecatePackageVersion(
        name,
        version,
        options.reason,
        options.replacement,
      );
      console.log(`deprecated ${name}@${version}`);
    } else {
      await deprecatePackage(name, options.reason, options.replacement);
      console.log(`deprecated package ${name}`);
    }
    return 0;
  } catch (error) {
    printError(error);
    return 1;
  }
}
