import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const meta = require("../scripts/llvm-version.json") as {
  version: string;
  supportedPlatforms: string[];
  deferredPlatforms: string[];
  npmPackages: Record<string, string>;
};

/** Pinned LLVM release used by Sonite native toolchain builds and bindings. */
export const PINNED_LLVM_VERSION: string = meta.version;

export const SUPPORTED_PLATFORMS: readonly string[] = meta.supportedPlatforms;

export const DEFERRED_PLATFORMS: readonly string[] = meta.deferredPlatforms;

export const PLATFORM_NPM_PACKAGES: Readonly<Record<string, string>> =
  meta.npmPackages;

export type SonitePlatformId =
  | "linux-x64"
  | "linux-arm64"
  | "macos-x64"
  | "macos-arm64"
  | "win32-x64"
  | "win32-arm64";

/**
 * Map Node's process.platform / process.arch to a Sonite platform id.
 * Uses `macos` (not `darwin`) in package names per distribution spec.
 */
export function detectPlatformId(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SonitePlatformId {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "win32" && arch === "arm64") return "win32-arm64";
  throw unsupportedPlatformError(`${platform}-${arch}`);
}

export function unsupportedPlatformError(platformLabel: string): Error {
  const lines = [
    `Sonite does not currently provide a native LLVM toolchain`,
    `for ${platformLabel}.`,
    "",
    "Supported platforms:",
    ...SUPPORTED_PLATFORMS.map((p) => `- ${p}`),
  ];
  return new Error(lines.join("\n"));
}

export function npmPackageForPlatform(id: SonitePlatformId): string {
  const name = PLATFORM_NPM_PACKAGES[id];
  if (!name) {
    throw unsupportedPlatformError(id);
  }
  return name;
}

/** Path helpers for scripts that live next to llvm-version.json */
export function llvmPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
