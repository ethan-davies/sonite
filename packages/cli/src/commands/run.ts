import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compileLinkAndRun } from "../native.js";
import { loadProject, ProjectError } from "../project.js";
import { runBuild } from "./build.js";

export interface RunOptions {
  readonly release?: boolean;
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

  const buildOpts: { release?: boolean; warningsAsErrors?: boolean } = {};
  if (options.release !== undefined) {
    buildOpts.release = options.release;
  }
  if (options.warningsAsErrors) {
    buildOpts.warningsAsErrors = true;
  }
  const status = await runBuild(buildOpts);
  if (status !== 0) {
    return status;
  }

  const binaryPath = join(project.outdirPath, project.binaryName);
  const run = spawnSync(binaryPath, [...args], { stdio: "inherit" });
  if (run.error) {
    console.error(`error: failed to run program: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}
