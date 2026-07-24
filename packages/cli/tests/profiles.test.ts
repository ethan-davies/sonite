import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProjectFromManifest,
  resolveProfile,
} from "../src/project.js";
import { selectProfileName } from "../src/commands/build.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeProject(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "sn-profile-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "project.toml"), body, "utf8");
  return root;
}

describe("build profiles", () => {
  it("defaults to debug and release profiles", () => {
    const root = writeProject(`\
[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"
`);
    const project = loadProjectFromManifest(join(root, "project.toml"));
    expect(resolveProfile(project, "debug")).toMatchObject({
      optimization: 0,
      debugInfo: true,
    });
    expect(resolveProfile(project, "release")).toMatchObject({
      optimization: 2,
      debugInfo: false,
    });
    expect(project.build.outdir).toBe("build");
  });

  it("supports custom profiles with inheritance", () => {
    const root = writeProject(`\
[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"

[profile.fast]
inherits = "release"
optimization = 3
`);
    const project = loadProjectFromManifest(join(root, "project.toml"));
    const fast = resolveProfile(project, "fast");
    expect(fast.optimization).toBe(3);
    expect(fast.debugInfo).toBe(false);
  });

  it("rejects invalid optimisation levels", () => {
    const root = writeProject(`\
[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"

[profile.release]
optimization = 9
`);
    expect(() =>
      loadProjectFromManifest(join(root, "project.toml")),
    ).toThrow(/optimization must be an integer 0–3/);
  });

  it("maps --release to the release profile name", () => {
    expect(selectProfileName({})).toBe("debug");
    expect(selectProfileName({ release: true })).toBe("release");
    expect(selectProfileName({ profile: "fast", release: true })).toBe("fast");
  });
});
