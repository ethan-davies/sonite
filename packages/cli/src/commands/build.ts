import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSourceFile, linkNative } from "../native.js";
import {
  deployRuntimeLibraries,
  resolveProjectNativeLink,
} from "../project-native.js";
import {
  loadProject,
  ProjectError,
  resolveProfile,
  type OptLevelInt,
} from "../project.js";
import type { OptLevel } from "@sonite/llvm";

export interface BuildOptions {
  readonly output?: string;
  readonly emitIr?: boolean;
  /** When true, only emit IR and skip native linking. */
  readonly irOnly?: boolean;
  readonly release?: boolean;
  /** Named profile from project.toml (`debug`, `release`, or custom). */
  readonly profile?: string;
  readonly optLevel?: OptLevel;
  readonly warningsAsErrors?: boolean;
}

function optLevelFromInt(n: OptLevelInt): OptLevel {
  switch (n) {
    case 0:
      return "O0";
    case 1:
      return "O1";
    case 2:
      return "O2";
    case 3:
      return "O3";
    default: {
      const _exhaustive: never = n;
      return _exhaustive;
    }
  }
}

/**
 * Resolve which profile to build with.
 * `--release` is sugar for `--profile release`.
 */
export function selectProfileName(options: BuildOptions): string {
  if (options.profile) {
    return options.profile;
  }
  if (options.release) {
    return "release";
  }
  return "debug";
}

export async function runBuild(options: BuildOptions = {}): Promise<number> {
  let project;
  try {
    project = loadProject();
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  let profile;
  try {
    profile = resolveProfile(project, selectProfileName(options));
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const optLevel = options.optLevel ?? optLevelFromInt(profile.optimization);
  const releaseLike = profile.name === "release" || profile.optimization >= 2;

  const compiled = compileSourceFile(project.entryPath, {
    ...(options.warningsAsErrors ? { warningsAsErrors: true } : {}),
    debugInfo: profile.debugInfo,
    release: releaseLike,
  });
  if (!compiled) {
    return 1;
  }

  // Profile-aware default: <outdir>/<profile>/<binary>
  const profileOutdir = join(project.outdirPath, profile.name);
  const binaryPath = options.output
    ? resolve(options.output)
    : join(profileOutdir, project.binaryName);

  const irOutdir = options.output ? project.outdirPath : profileOutdir;
  const irPath =
    options.emitIr || options.irOnly
      ? join(irOutdir, `${project.binaryName}.ll`)
      : undefined;

  if (options.irOnly) {
    mkdirSync(irOutdir, { recursive: true });
    const out = irPath ?? join(irOutdir, `${project.binaryName}.ll`);
    writeFileSync(out, compiled.ir, "utf8");
    console.log(`wrote ${out}`);
    return 0;
  }

  const nativeLink = resolveProjectNativeLink(project);

  const linkOpts: Parameters<typeof linkNative>[0] = {
    ir: compiled.ir,
    outputPath: binaryPath,
    nativeLink,
    optLevel,
    ...(irPath !== undefined ? { emitIrPath: irPath } : {}),
    release: releaseLike,
  };

  const status = await linkNative(linkOpts);

  if (status !== 0) {
    return status;
  }

  try {
    deployRuntimeLibraries(binaryPath, nativeLink);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    return 1;
  }

  if (irPath) {
    console.log(`wrote ${irPath}`);
  }
  console.log(`wrote ${binaryPath}`);
  return 0;
}
