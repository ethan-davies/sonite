import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compileLinkAndRun } from "../native.js";
import { loadProject, ProjectError, resolveProfile } from "../project.js";
import { runBuild, selectProfileName, type BuildOptions } from "./build.js";

export interface RunOptions {
  readonly release?: boolean;
  readonly profile?: string;
  readonly warningsAsErrors?: boolean;
}

export async function runRun(
  input: string | undefined,
  args: readonly string[] = [],
  options: RunOptions = {},
): Promise<number> {
  if (input) {
    const runOpts: { release?: boolean; warningsAsErrors?: boolean } = {};
    if (options.release !== undefined) {
      runOpts.release = options.release;
    }
    if (options.warningsAsErrors) {
      runOpts.warningsAsErrors = true;
    }
    return compileLinkAndRun(input, args, runOpts);
  }

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

  const buildOpts: BuildOptions = {
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.warningsAsErrors ? { warningsAsErrors: true } : {}),
  };
  const status = await runBuild(buildOpts);
  if (status !== 0) {
    return status;
  }

  let profile;
  try {
    profile = resolveProfile(project, selectProfileName(buildOpts));
  } catch (error) {
    if (error instanceof ProjectError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const binaryPath = join(project.outdirPath, profile.name, project.binaryName);
  const run = spawnSync(binaryPath, [...args], { stdio: "inherit" });
  if (run.error) {
    console.error(`error: failed to run program: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}
