import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { hostRuntimePlatformId, type RuntimePlatformId } from "@sonite/runtime";
import {
  inferArtifactKind,
  isNativePackageTarget,
  listBundledNativeTargets,
  nativePlatformKeys,
  parseNativeConfig,
  type NativeArtifactKind,
  type ParsedNativeConfig,
} from "../native-deps.js";
import { loadProjectFromManifest, ProjectError } from "../project.js";
import { versionSatisfies } from "./semver.js";
import {
  materializeNativeArtifact,
  sha256File,
} from "./native-cache.js";
import type { LockNative, LockPackage } from "./lock.js";
import { packageVersionPath } from "./store.js";

export class NativeResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeResolveError";
  }
}

export interface ResolvedNativeArtifact {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly nativeName: string;
  readonly nativeVersion: string;
  readonly platformId: RuntimePlatformId;
  readonly kind: NativeArtifactKind;
  /** Absolute path to the artifact in the package store (pre-cache). */
  readonly sourcePath: string;
  /** Path relative to the package root. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly filename: string;
}

function splitPlatformId(platformId: RuntimePlatformId): {
  platform: string;
  architecture: string;
} {
  const [platform, architecture] = platformId.split("-") as [string, string];
  return { platform, architecture };
}

function loadPackageNativeConfig(
  packageRoot: string,
): ParsedNativeConfig | null {
  const manifest = join(packageRoot, "project.toml");
  if (!existsSync(manifest)) {
    return null;
  }
  try {
    const project = loadProjectFromManifest(manifest);
    return project.native;
  } catch {
    return null;
  }
}

function packageDeclaresNativeArtifacts(
  packageRoot: string,
  config: ParsedNativeConfig,
): boolean {
  if (config.base.libraries.length > 0 || config.base.library) {
    return true;
  }
  for (const section of config.platforms.values()) {
    if (section.libraries.length > 0 || section.library) {
      return true;
    }
  }
  return listBundledNativeTargets(packageRoot).length > 0;
}

function findArtifactInPlatformDir(
  platformDir: string,
  config: ParsedNativeConfig,
  platformId: RuntimePlatformId,
): string | null {
  if (!existsSync(platformDir)) {
    return null;
  }

  const keys = nativePlatformKeys(platformId);
  let explicitLibrary: string | undefined = config.base.library;
  for (const key of keys) {
    const section = config.platforms.get(key);
    if (section?.library) {
      explicitLibrary = section.library;
    }
  }
  if (explicitLibrary) {
    const path = join(platformDir, explicitLibrary);
    if (existsSync(path)) {
      return path;
    }
  }

  const libNames =
    config.base.libraries.length > 0
      ? config.base.libraries
      : keys.flatMap((k) => config.platforms.get(k)?.libraries ?? []);

  const preferDynamic =
    config.link === "dynamic" || config.kind === "dynamic";
  const files = readdirSync(platformDir).filter((f) => {
    if (platformId.startsWith("win32")) {
      return /\.(lib|dll|a)$/i.test(f);
    }
    if (platformId.startsWith("macos")) {
      return /\.(a|dylib)$/i.test(f);
    }
    return /\.(a|so)$/i.test(f);
  });

  if (libNames.length > 0) {
    for (const lib of libNames) {
      const candidates = preferDynamic
        ? [
            `lib${lib}.so`,
            `lib${lib}.dylib`,
            `${lib}.dll`,
            `${lib}.lib`,
            `lib${lib}.a`,
            `${lib}.a`,
          ]
        : [
            `lib${lib}.a`,
            `${lib}.a`,
            `${lib}.lib`,
            `lib${lib}.so`,
            `lib${lib}.dylib`,
            `${lib}.dll`,
          ];
      for (const name of candidates) {
        if (files.includes(name)) {
          return join(platformDir, name);
        }
      }
    }
  }

  // Fall back to first static, then first dynamic
  const staticFile = files.find((f) => /\.(a|lib)$/i.test(f));
  if (staticFile && !preferDynamic) {
    return join(platformDir, staticFile);
  }
  const dynamicFile = files.find((f) => /\.(so|dylib|dll)$/i.test(f));
  if (dynamicFile) {
    return join(platformDir, dynamicFile);
  }
  if (staticFile) {
    return join(platformDir, staticFile);
  }
  return null;
}

function formatMissingArtifact(
  packageName: string,
  packageVersion: string,
  platformId: RuntimePlatformId,
  available: readonly string[],
): string {
  const { platform, architecture } = splitPlatformId(platformId);
  const supported =
    available.length > 0
      ? available.map((t) => `    ${t}`).join("\n")
      : "    (none)";
  return [
    `Package \`${packageName}@${packageVersion}\` does not provide a native artifact for:`,
    "",
    `    Platform: ${platform}`,
    `    Architecture: ${architecture}`,
    "",
    "Supported targets:",
    "",
    supported,
  ].join("\n");
}

/**
 * Resolve native artifacts for installed Sonite packages on the host platform.
 * Fails early when a package declares native artifacts but lacks the host target.
 */
export function resolveNativeArtifacts(
  packages: readonly LockPackage[],
  platformId: RuntimePlatformId = hostRuntimePlatformId(),
  options?: {
    /** Override package store lookup (tests). */
    readonly packageRootFor?: (name: string, version: string) => string;
  },
): ResolvedNativeArtifact[] {
  if (!isNativePackageTarget(platformId) && platformId !== "win32-arm64") {
    throw new NativeResolveError(
      `Unsupported native package platform '${platformId}'.`,
    );
  }
  if (platformId === "win32-arm64") {
    throw new NativeResolveError(
      "Windows ARM64 is not a supported Phase 5 native package target.",
    );
  }

  const packageRootFor =
    options?.packageRootFor ?? ((name, version) => packageVersionPath(name, version));

  // Collect providers by native name for conflict detection
  type Provider = {
    packageName: string;
    packageVersion: string;
    packageRoot: string;
    config: ParsedNativeConfig;
    nativeName: string;
    nativeVersion: string;
  };
  const providers: Provider[] = [];

  for (const pkg of packages) {
    const packageRoot = packageRootFor(pkg.name, pkg.version);
    if (!existsSync(join(packageRoot, "project.toml"))) {
      continue;
    }
    const config = loadPackageNativeConfig(packageRoot);
    if (!config) {
      continue;
    }
    if (!packageDeclaresNativeArtifacts(packageRoot, config)) {
      continue;
    }

    const nativeName = config.name ?? pkg.name;
    const nativeVersion = config.version ?? pkg.version;
    providers.push({
      packageName: pkg.name,
      packageVersion: pkg.version,
      packageRoot,
      config,
      nativeName,
      nativeVersion,
    });
  }

  // Conflict detection: same native name with incompatible major versions
  const byName = new Map<string, Provider[]>();
  for (const p of providers) {
    const list = byName.get(p.nativeName) ?? [];
    list.push(p);
    byName.set(p.nativeName, list);
  }
  for (const [nativeName, list] of byName) {
    if (list.length < 2) {
      continue;
    }
    const versions = [...new Set(list.map((p) => p.nativeVersion))];
    if (versions.length <= 1) {
      continue;
    }
    let conflict = false;
    for (let i = 0; i < versions.length; i++) {
      for (let j = i + 1; j < versions.length; j++) {
        const a = versions[i]!;
        const b = versions[j]!;
        if (!versionSatisfies(a, `^${b}`) && !versionSatisfies(b, `^${a}`)) {
          conflict = true;
        }
      }
    }
    if (conflict) {
      const lines = list.map(
        (p) =>
          `Package ${p.packageName} requires ${nativeName} ${p.nativeVersion}`,
      );
      throw new NativeResolveError(
        [
          ...lines,
          "",
          "No compatible native version could be resolved.",
        ].join("\n"),
      );
    }
  }

  const resolved: ResolvedNativeArtifact[] = [];
  const seenNative = new Set<string>();

  for (const p of providers) {
    if (seenNative.has(p.nativeName)) {
      continue;
    }
    seenNative.add(p.nativeName);

    const available = listBundledNativeTargets(p.packageRoot);
    // Also accept windows-x64 directory as win32-x64
    const platformDirCandidates = [
      join(p.packageRoot, "native", platformId),
      platformId.startsWith("win32")
        ? join(
            p.packageRoot,
            "native",
            platformId.replace("win32-", "windows-"),
          )
        : null,
    ].filter((d): d is string => d !== null);

    let sourcePath: string | null = null;
    for (const dir of platformDirCandidates) {
      sourcePath = findArtifactInPlatformDir(dir, p.config, platformId);
      if (sourcePath) {
        break;
      }
    }

    if (!sourcePath) {
      throw new NativeResolveError(
        formatMissingArtifact(
          p.packageName,
          p.packageVersion,
          platformId,
          available,
        ),
      );
    }

    const kind =
      p.config.kind ?? inferArtifactKind(sourcePath);
    const filename = basename(sourcePath);
    const relativePath = relative(p.packageRoot, sourcePath).replace(
      /\\/g,
      "/",
    );
    const sha256 = sha256File(sourcePath);

    resolved.push({
      packageName: p.packageName,
      packageVersion: p.packageVersion,
      packageRoot: p.packageRoot,
      nativeName: p.nativeName,
      nativeVersion: p.nativeVersion,
      platformId,
      kind,
      sourcePath,
      relativePath,
      sha256,
      filename,
    });
  }

  return resolved;
}

/** Materialize resolved natives into the cache and produce lockfile entries. */
export function installNativeArtifacts(
  artifacts: readonly ResolvedNativeArtifact[],
  locked?: readonly LockNative[],
): LockNative[] {
  const lockByKey = new Map<string, LockNative>();
  if (locked) {
    for (const entry of locked) {
      lockByKey.set(`${entry.name}@${entry.platform}-${entry.architecture}`, entry);
    }
  }

  const natives: LockNative[] = [];
  for (const art of artifacts) {
    const { platform, architecture } = splitPlatformId(art.platformId);
    const lockKey = `${art.nativeName}@${platform}-${architecture}`;
    const previous = lockByKey.get(lockKey);
    const expectedSha = previous?.sha256 ?? art.sha256;

    if (previous && previous.sha256 !== art.sha256) {
      // Locked hash must match the artifact we found
      throw new NativeResolveError(
        [
          "Integrity verification failed for native dependency:",
          "",
          `    Package: ${art.nativeName}`,
          `    Version: ${art.nativeVersion}`,
          "",
          "Expected:",
          `    ${previous.sha256}`,
          "",
          "Received:",
          `    ${art.sha256}`,
          "",
          "The artifact was not installed.",
        ].join("\n"),
      );
    }

    materializeNativeArtifact({
      name: art.nativeName,
      version: art.nativeVersion,
      platformId: art.platformId,
      sourcePath: art.sourcePath,
      expectedSha256: expectedSha,
    });

    natives.push({
      package: art.packageName,
      name: art.nativeName,
      version: art.nativeVersion,
      platform,
      architecture,
      kind: art.kind,
      source: "bundled",
      path: art.relativePath,
      sha256: art.sha256,
      filename: art.filename,
    });
  }
  return natives;
}

export function formatNativeInstallReport(
  packages: readonly LockPackage[],
  natives: readonly LockNative[],
): string {
  const lines: string[] = ["Installing dependencies...", ""];
  lines.push("Sonite packages:");
  if (packages.length === 0) {
    lines.push("  (none)");
  } else {
    for (const pkg of packages) {
      lines.push(`  ${pkg.name}@${pkg.version}`);
    }
  }
  lines.push("");
  lines.push("Native packages:");
  if (natives.length === 0) {
    lines.push("  (none)");
  } else {
    for (const n of natives) {
      lines.push(`  ${n.name}@${n.version}`);
      lines.push(`    target: ${n.platform}-${n.architecture}`);
      lines.push(`    kind: ${n.kind}`);
      lines.push("    verified: SHA-256");
    }
  }
  lines.push("");
  lines.push("Installation complete.");
  return lines.join("\n");
}

export function formatNativeAddReport(natives: readonly LockNative[]): string {
  if (natives.length === 0) {
    return "";
  }
  const lines = ["", "Native dependencies:"];
  for (const n of natives) {
    lines.push(`  ${n.name}@${n.version}`);
  }
  return lines.join("\n");
}
