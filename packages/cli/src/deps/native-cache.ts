import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getCacheDir } from "../config.js";

/** `~/.cache/sonite/native/<name>/<version>/<platform>/` */
export function nativeCacheRoot(): string {
  return join(getCacheDir(), "native");
}

export function nativeArtifactCacheDir(
  name: string,
  version: string,
  platformId: string,
): string {
  return join(nativeCacheRoot(), name, version, platformId);
}

export function nativeArtifactCachePath(
  name: string,
  version: string,
  platformId: string,
  filename: string,
): string {
  return join(nativeArtifactCacheDir(name, version, platformId), filename);
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export class NativeIntegrityError extends Error {
  constructor(
    readonly nativeName: string,
    readonly version: string,
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      [
        "Integrity verification failed for native dependency:",
        "",
        `    Package: ${nativeName}`,
        `    Version: ${version}`,
        "",
        "Expected:",
        `    ${expected}`,
        "",
        "Received:",
        `    ${received}`,
        "",
        "The artifact was not installed.",
      ].join("\n"),
    );
    this.name = "NativeIntegrityError";
  }
}

/**
 * Copy an artifact into the native cache, verifying SHA-256 when `expectedSha`
 * is provided. Returns the absolute cached path.
 */
export function materializeNativeArtifact(options: {
  readonly name: string;
  readonly version: string;
  readonly platformId: string;
  readonly sourcePath: string;
  readonly expectedSha256?: string;
}): string {
  const filename = basename(options.sourcePath);
  const destDir = nativeArtifactCacheDir(
    options.name,
    options.version,
    options.platformId,
  );
  const destPath = join(destDir, filename);

  if (!existsSync(options.sourcePath)) {
    throw new Error(
      `Native artifact source missing: ${options.sourcePath}`,
    );
  }

  const actual = sha256File(options.sourcePath);
  if (
    options.expectedSha256 !== undefined &&
    actual !== options.expectedSha256
  ) {
    throw new NativeIntegrityError(
      options.name,
      options.version,
      options.expectedSha256,
      actual,
    );
  }

  if (existsSync(destPath)) {
    const cached = sha256File(destPath);
    if (cached === actual) {
      return destPath;
    }
    // Stale/corrupt cache entry — replace
    rmSync(destPath, { force: true });
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(options.sourcePath, destPath);

  const cached = sha256File(destPath);
  if (cached !== actual) {
    rmSync(destPath, { force: true });
    throw new NativeIntegrityError(
      options.name,
      options.version,
      actual,
      cached,
    );
  }

  return destPath;
}

/** Remove the entire native artifact cache. Safe — artifacts can be re-fetched. */
export function cleanNativeCache(): { removed: boolean; path: string } {
  const root = nativeCacheRoot();
  if (!existsSync(root)) {
    return { removed: false, path: root };
  }
  rmSync(root, { recursive: true, force: true });
  return { removed: true, path: root };
}
