import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { getPackagesStoreDir } from "../config.js";
import { RegistryError } from "../registry/client.js";
import {
  downloadPackageVersion,
  getVersion,
} from "../registry/packages.js";
import {
  addDependant,
  isPackageVersionInstalled,
  packageChecksumPath,
  packageVersionPath,
  releasePreviousVersion,
} from "./store.js";

export interface FetchedPackage {
  readonly name: string;
  readonly version: string;
  readonly checksum: string;
}

/**
 * Ensure `name@version` exists in the global store and register `projectRoot`
 * as a dependant. Skips download when already cached and checksum matches.
 */
export async function installPackageVersion(
  projectRoot: string,
  name: string,
  version: string,
  expectedChecksum?: string,
): Promise<FetchedPackage> {
  const dest = packageVersionPath(name, version);
  mkdirSync(getPackagesStoreDir(), { recursive: true });

  let checksum = expectedChecksum?.trim() ?? "";
  const cached = isPackageVersionInstalled(name, version);

  if (cached) {
    const sidecar = readStoredChecksum(name, version);
    if (expectedChecksum) {
      if (
        sidecar &&
        sidecar.toLowerCase() === expectedChecksum.toLowerCase()
      ) {
        checksum = expectedChecksum;
      } else {
        // Missing or mismatched sidecar — re-download and verify against lock.
        await downloadAndExtract(name, version, dest, expectedChecksum);
        checksum = expectedChecksum;
      }
    } else if (sidecar) {
      checksum = sidecar;
    } else {
      const meta = await getVersion(name, version);
      checksum = meta.checksumSha256;
      writeStoredChecksum(name, version, checksum);
    }
  } else {
    checksum = await downloadAndExtract(name, version, dest, expectedChecksum);
  }

  if (!checksum) {
    throw new RegistryError(
      `missing checksum for ${name}@${version}`,
      502,
      "checksum_missing",
    );
  }

  releasePreviousVersion(name, version, projectRoot);
  addDependant(name, version, projectRoot);

  return { name, version, checksum };
}

async function downloadAndExtract(
  name: string,
  version: string,
  dest: string,
  expectedChecksum?: string,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "sn-pkg-"));
  const archivePath = join(tmp, `${name}-${version}.tar.gz`);
  try {
    const downloaded = await downloadPackageVersion(
      name,
      version,
      archivePath,
    );
    const checksum = downloaded.checksumSha256;
    if (
      expectedChecksum &&
      expectedChecksum.toLowerCase() !== checksum.toLowerCase()
    ) {
      throw new RegistryError(
        `checksum mismatch for ${name}@${version} (lockfile vs download)`,
        502,
        "checksum_mismatch",
      );
    }

    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    await tar.x({
      file: archivePath,
      cwd: dest,
    });
    writeStoredChecksum(name, version, checksum);
    return checksum;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readStoredChecksum(name: string, version: string): string | null {
  const path = packageChecksumPath(name, version);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function writeStoredChecksum(
  name: string,
  version: string,
  checksum: string,
): void {
  const dest = packageVersionPath(name, version);
  mkdirSync(dest, { recursive: true });
  writeFileSync(packageChecksumPath(name, version), `${checksum}\n`, "utf8");
}
