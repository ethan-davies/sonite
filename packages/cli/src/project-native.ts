import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hostRuntimePlatformId, type RuntimePlatformId } from "@sonite/runtime";
import { discoverInstalledPackages } from "./deps/install.js";
import { loadLockfile, type LockNative } from "./deps/lock.js";
import { nativeArtifactCachePath } from "./deps/native-cache.js";
import {
  mergeNativeLinkSpecs,
  resolveNativeLinkSpec,
  type NativeLinkSpec,
  type ParsedNativeConfig,
} from "./native-deps.js";
import type { Project } from "./project.js";
import { loadProjectFromManifest } from "./project.js";

function lockedArtifactPath(
  entry: LockNative,
  packageRoot: string,
): string | null {
  const platformId = `${entry.platform}-${entry.architecture}`;
  const cached = nativeArtifactCachePath(
    entry.name,
    entry.version,
    platformId,
    entry.filename,
  );
  if (existsSync(cached)) {
    return cached;
  }
  const bundled = join(packageRoot, entry.path);
  if (existsSync(bundled)) {
    return bundled;
  }
  return null;
}

/**
 * Resolve native link inputs for the project root plus all installed dependencies.
 */
export function resolveProjectNativeLink(
  project: Project,
  platform: RuntimePlatformId = hostRuntimePlatformId(),
): NativeLinkSpec {
  const specs: NativeLinkSpec[] = [
    resolveNativeLinkSpec(project.root, project.native, platform),
  ];

  const lock = loadLockfile(project.root);
  const installed = discoverInstalledPackages(project);

  for (const [name, info] of installed) {
    let depNative: ParsedNativeConfig | null = null;
    try {
      depNative = loadProjectFromManifest(join(info.dir, "project.toml")).native;
    } catch {
      continue;
    }

    const lockEntries =
      lock?.natives.filter((n) => n.package === name) ?? [];
    const extraDirs: string[] = [];
    const lockedFiles: string[] = [];

    for (const entry of lockEntries) {
      const path = lockedArtifactPath(entry, info.dir);
      if (path) {
        lockedFiles.push(path);
        extraDirs.push(dirname(path));
      }
    }

    // Also search package store native/<platform> and cache
    extraDirs.push(join(info.dir, "native", platform));
    if (platform.startsWith("win32")) {
      extraDirs.push(
        join(info.dir, "native", platform.replace("win32-", "windows-")),
      );
    }

    const depSpec = resolveNativeLinkSpec(
      info.dir,
      depNative,
      platform,
      extraDirs,
    );

    // Prefer locked absolute files when present
    if (lockedFiles.length > 0) {
      const runtimeLibraries = [
        ...depSpec.runtimeLibraries,
        ...lockedFiles.filter((f) => /\.(so|dylib|dll)$/i.test(f)),
      ];
      // Windows .lib may need sibling .dll
      for (const f of lockedFiles) {
        if (f.toLowerCase().endsWith(".lib")) {
          const dll = f.replace(/\.lib$/i, ".dll");
          if (existsSync(dll)) {
            runtimeLibraries.push(dll);
          }
        }
      }
      specs.push({
        libraryFiles: [...new Set([...lockedFiles, ...depSpec.libraryFiles])],
        libraryPaths: [
          ...new Set([...depSpec.libraryPaths, ...extraDirs]),
        ],
        systemLibraries: depSpec.systemLibraries,
        linkArgs: depSpec.linkArgs,
        headers: depSpec.headers,
        runtimeLibraries: [...new Set(runtimeLibraries)],
      });
    } else {
      specs.push(depSpec);
    }
  }

  return mergeNativeLinkSpecs(...specs);
}

/**
 * Copy runtime dynamic libraries next to the output binary.
 * Returns paths that were copied (or already present).
 */
export function deployRuntimeLibraries(
  outputBinaryPath: string,
  nativeLink: NativeLinkSpec,
): string[] {
  const outDir = dirname(resolve(outputBinaryPath));
  mkdirSync(outDir, { recursive: true });
  const deployed: string[] = [];

  for (const lib of nativeLink.runtimeLibraries) {
    if (!existsSync(lib)) {
      throw new Error(
        `The dynamic library \`${basename(lib)}\` could not be included in the application output (missing: ${lib}).`,
      );
    }
    const dest = join(outDir, basename(lib));
    if (resolve(lib) !== resolve(dest)) {
      copyFileSync(lib, dest);
    }
    deployed.push(dest);
  }
  return deployed;
}

export { portableRpathArgs } from "./native-deps.js";
