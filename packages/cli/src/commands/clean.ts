import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProject, ProjectError } from "../project.js";

/**
 * Remove generated build artifacts for the current project.
 * Does not delete installed dependencies or the native artifact cache.
 */
export function runClean(): number {
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

  const targets = [
    project.outdirPath,
    // Legacy default from earlier toolchains
    resolve(project.root, "dist"),
  ];

  // Also clean profile subdirectories when outdir is the parent `build/`
  const seen = new Set<string>();
  let removed = 0;
  for (const target of targets) {
    const abs = resolve(target);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      console.log(`removed ${abs}`);
      removed += 1;
    }
  }

  // Profile-aware layout: build/debug, build/release under project root when
  // outdir is exactly `build`.
  if (project.build.outdir === "build" || project.build.outdir === "dist") {
    for (const profile of Object.keys(project.profiles).concat([
      "debug",
      "release",
    ])) {
      const profileDir = join(project.root, project.build.outdir, profile);
      const abs = resolve(profileDir);
      if (seen.has(abs)) continue;
      // Already removed if parent was deleted
      if (existsSync(abs)) {
        rmSync(abs, { recursive: true, force: true });
        console.log(`removed ${abs}`);
        removed += 1;
      }
    }
  }

  if (removed === 0) {
    console.log("nothing to clean");
  }
  return 0;
}
