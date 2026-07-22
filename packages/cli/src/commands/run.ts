import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compileLinkAndRun } from "../native.js";
import { loadProject, ProjectError } from "../project.js";
import { runBuild } from "./build.js";

export async function runRun(
  input: string | undefined,
  args: readonly string[] = [],
): Promise<number> {
  if (input) {
    return compileLinkAndRun(input, args);
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

  const status = await runBuild();
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
