import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFmt } from "../src/commands/fmt.js";

function writeProject(root: string, files: Record<string, string>): void {
  writeFileSync(
    join(root, "project.toml"),
    `[package]
name = "fmt-test"
version = "0.0.0"
entry = "main.sn"
`,
  );
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

describe("sn fmt", () => {
  it("formats files and supports --check", () => {
    const root = mkdtempSync(join(tmpdir(), "sn-fmt-"));
    const prev = process.cwd();
    try {
      writeProject(root, {
        "main.sn": `function main(): void {print("x");}
`,
      });
      process.chdir(root);
      expect(runFmt({ paths: [], check: true, write: false })).toBe(1);
      expect(runFmt({ paths: [], check: false, write: true })).toBe(0);
      expect(readFileSync(join(root, "main.sn"), "utf8")).toContain(
        'print("x");',
      );
      expect(runFmt({ paths: [], check: true, write: false })).toBe(0);
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats only git-changed files with --changed", () => {
    const root = mkdtempSync(join(tmpdir(), "sn-fmt-changed-"));
    const prev = process.cwd();
    try {
      writeProject(root, {
        "main.sn": `function main(): void {
    print("ok");
}
`,
        "other.sn": `function other(): void {print("y");}
`,
      });
      process.chdir(root);
      const init = spawnSync("git", ["init"], { encoding: "utf8" });
      expect(init.status).toBe(0);
      spawnSync("git", ["config", "user.email", "test@example.com"]);
      spawnSync("git", ["config", "user.name", "Test"]);
      spawnSync("git", ["add", "main.sn", "project.toml"]);
      spawnSync("git", ["commit", "-m", "init"], { encoding: "utf8" });

      // only other.sn is untracked/changed
      expect(
        runFmt({ paths: [], check: false, write: true, changed: true }),
      ).toBe(0);
      expect(readFileSync(join(root, "other.sn"), "utf8")).toMatch(
        /function other\(\): void \{\n    print\("y"\);\n\}\n/,
      );
      // main.sn should remain as committed (already formatted-ish)
      expect(readFileSync(join(root, "main.sn"), "utf8")).toContain(
        'print("ok")',
      );
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
