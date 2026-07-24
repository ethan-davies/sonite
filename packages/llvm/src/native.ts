import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPlatformId,
  npmPackageForPlatform,
  SUPPORTED_PLATFORMS,
  unsupportedPlatformError,
  type SonitePlatformId,
} from "./version.js";

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeBinding {
  getLlvmVersion(): string;
  getExpectedLlvmVersion(): string;
  getLldVersion(): string;
  assertLlvmVersion(): boolean;
  getDefaultTriple(): string;
  getHostCpu(): string;
  getHostFeatures(): string;
  createBackend(ir: string): NativeBackendHandle;
  backendTarget(this: NativeBackendHandle, config: Record<string, string>): void;
  backendVerify(this: NativeBackendHandle): void;
  backendEmitObject(this: NativeBackendHandle, path: string): void;
  backendDispose(this: NativeBackendHandle): void;
  backendGetTriple(this: NativeBackendHandle): string;
  createLinker(opts?: { flavor?: string }): NativeLinkerHandle;
  linkerAddObject(this: NativeLinkerHandle, path: string): void;
  linkerAddLibrary(this: NativeLinkerHandle, path: string): void;
  linkerAddLibraryPath(this: NativeLinkerHandle, path: string): void;
  linkerAddSystemLibrary(this: NativeLinkerHandle, name: string): void;
  linkerAddArg(this: NativeLinkerHandle, arg: string): void;
  linkerAddTrailingArg(this: NativeLinkerHandle, arg: string): void;
  linkerSetOutput(this: NativeLinkerHandle, path: string): void;
  linkerLink(this: NativeLinkerHandle): void;
  linkerDispose(this: NativeLinkerHandle): void;
}

export interface NativeBackendHandle {
  state: unknown;
}

export interface NativeLinkerHandle {
  state: unknown;
}

interface PlatformPackage {
  loadBinding(): NativeBinding;
  getAddonPath(): string;
  getLibDir(): string;
}

let cached: NativeBinding | null = null;

function localDevCandidates(): string[] {
  const platform = `${process.platform}-${process.arch}`;
  return [
    join(packageRoot, "prebuilds", `sonite_llvm-${platform}.node`),
    join(packageRoot, "build", "Release", "sonite_llvm.node"),
    join(packageRoot, "build", "Debug", "sonite_llvm.node"),
  ];
}

function tryLoadPlatformPackage(id: SonitePlatformId): NativeBinding | null {
  const name = npmPackageForPlatform(id);
  try {
    // Dynamic package name — resolved via optionalDependencies / workspace.
    const pkg = require(name) as PlatformPackage;
    return pkg.loadBinding();
  } catch {
    return null;
  }
}

function tryLoadLocalDev(): NativeBinding | null {
  // Prefer platform package path under monorepo even without install resolution.
  try {
    const id = detectPlatformId();
    const sibling = join(
      packageRoot,
      "..",
      `llvm-${id}`,
      "native",
      "sonite_llvm.node",
    );
    if (existsSync(sibling)) {
      // Ensure Linux/macOS can find bundled libs via rpath ../lib from native/
      return require(sibling) as NativeBinding;
    }
  } catch {
    /* fall through */
  }

  for (const path of localDevCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return require(path) as NativeBinding;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function isNativeBindingAvailable(): boolean {
  try {
    loadNative();
    return true;
  } catch {
    return false;
  }
}

export function loadNative(): NativeBinding {
  if (cached) {
    return cached;
  }

  let platformId: SonitePlatformId;
  try {
    platformId = detectPlatformId();
  } catch (error) {
    throw error instanceof Error
      ? error
      : unsupportedPlatformError(`${process.platform}-${process.arch}`);
  }

  if (platformId === "win32-arm64") {
    throw unsupportedPlatformError("win32-arm64");
  }

  let binding =
    tryLoadPlatformPackage(platformId) ?? tryLoadLocalDev();

  if (!binding) {
    const lines = [
      `Sonite native LLVM toolchain is not available for ${platformId}.`,
      "",
      "Supported platforms:",
      ...SUPPORTED_PLATFORMS.map((p) => `- ${p}`),
      "",
      "Install the matching optional package or run: pnpm build:native",
    ];
    throw new Error(lines.join("\n"));
  }

  binding.assertLlvmVersion();
  cached = binding;
  return cached;
}
