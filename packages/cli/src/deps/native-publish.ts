import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_PACKAGE_TARGETS,
  isNativePackageTarget,
  type NativeArtifactKind,
  type NativePackageTarget,
} from "../native-deps.js";
import type { Project } from "../project.js";
import { ProjectError } from "../project.js";

export interface NativePublishTarget {
  readonly target: NativePackageTarget;
  readonly kind: NativeArtifactKind;
  readonly library: string;
  readonly sha256: string;
  readonly relativePath: string;
}

export interface NativePublishMetadata {
  readonly native: Record<
    string,
    {
      readonly kind: NativeArtifactKind;
      readonly library: string;
      readonly sha256: string;
      readonly path: string;
    }
  >;
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function inferKind(filename: string): NativeArtifactKind {
  if (/\.(so|dylib|dll)$/i.test(filename)) {
    return "dynamic";
  }
  return "static";
}

function pickPrimaryArtifact(
  dir: string,
  preferredLibrary: string | undefined,
  preferDynamic: boolean,
): { filename: string; kind: NativeArtifactKind } | null {
  const files = readdirSync(dir).filter((f) => {
    const st = statSync(join(dir, f));
    return st.isFile() && /\.(a|lib|so|dylib|dll)$/i.test(f);
  });
  if (files.length === 0) {
    return null;
  }
  if (preferredLibrary && files.includes(preferredLibrary)) {
    return {
      filename: preferredLibrary,
      kind: inferKind(preferredLibrary),
    };
  }
  const statics = files.filter((f) => /\.(a|lib)$/i.test(f));
  const dynamics = files.filter((f) => /\.(so|dylib|dll)$/i.test(f));
  if (preferDynamic && dynamics[0]) {
    return { filename: dynamics[0], kind: "dynamic" };
  }
  if (statics[0]) {
    return { filename: statics[0], kind: "static" };
  }
  if (dynamics[0]) {
    return { filename: dynamics[0], kind: "dynamic" };
  }
  return null;
}

/**
 * Validate `native/` layout for publish and build registry metadata.
 */
export function collectNativePublishArtifacts(
  project: Project,
): {
  targets: NativePublishTarget[];
  metadata: NativePublishMetadata | null;
} {
  const nativeRoot = join(project.root, "native");
  if (!existsSync(nativeRoot)) {
    return { targets: [], metadata: null };
  }

  const config = project.native;
  const preferDynamic =
    config.link === "dynamic" || config.kind === "dynamic";
  const seen = new Map<string, NativePublishTarget>();

  for (const entry of readdirSync(nativeRoot)) {
    const full = join(nativeRoot, entry);
    if (!statSync(full).isDirectory()) {
      continue;
    }
    if (entry === "include") {
      continue;
    }

    let targetId = entry;
    if (entry === "windows-x64") {
      targetId = "win32-x64";
    } else if (entry.startsWith("windows-")) {
      throw new ProjectError(
        `unsupported native platform directory 'native/${entry}' (Windows ARM64 is not supported; use win32-x64)`,
      );
    }

    if (!isNativePackageTarget(targetId)) {
      // Allow non-target dirs (e.g. source trees) but reject unknown *-arch patterns
      if (/^(linux|macos|darwin|win32|windows)-/.test(entry)) {
        throw new ProjectError(
          `unsupported native platform directory 'native/${entry}'. Supported: ${NATIVE_PACKAGE_TARGETS.join(", ")}`,
        );
      }
      continue;
    }

    if (seen.has(targetId)) {
      throw new ProjectError(
        `duplicate native target '${targetId}' (check native/${entry} and aliases)`,
      );
    }

    const platformKey = targetId;
    const preferred =
      config.platforms.get(platformKey)?.library ??
      config.platforms.get(entry)?.library ??
      config.base.library;

    const picked = pickPrimaryArtifact(full, preferred, preferDynamic);
    if (!picked) {
      throw new ProjectError(
        `native/${entry} contains no static/dynamic library artifact`,
      );
    }

    const relativePath = `native/${entry}/${picked.filename}`;
    const abs = join(project.root, relativePath);
    const sha256 = sha256Buffer(readFileSync(abs));
    const kind = config.kind ?? picked.kind;

    seen.set(targetId, {
      target: targetId as NativePackageTarget,
      kind,
      library: picked.filename,
      sha256,
      relativePath,
    });
  }

  const targets = [...seen.values()].sort((a, b) =>
    a.target.localeCompare(b.target),
  );
  if (targets.length === 0) {
    return { targets: [], metadata: null };
  }

  const native: NativePublishMetadata["native"] = {};
  for (const t of targets) {
    native[t.target] = {
      kind: t.kind,
      library: t.library,
      sha256: t.sha256,
      path: t.relativePath,
    };
  }

  return { targets, metadata: { native } };
}

/** Pretty-print publish checklist lines for native targets. */
export function formatNativePublishChecklist(
  targets: readonly NativePublishTarget[],
): string[] {
  const lines: string[] = ["Source package ............ OK"];
  const labels: Record<string, string> = {
    "linux-x64": "linux-x64 native .......... OK",
    "linux-arm64": "linux-arm64 native ........ OK",
    "macos-x64": "macos-x64 native .......... OK",
    "macos-arm64": "macos-arm64 native ........ OK",
    "win32-x64": "win32-x64 native .......... OK",
  };
  for (const t of targets) {
    lines.push(labels[t.target] ?? `${t.target} native .......... OK`);
  }
  return lines;
}
