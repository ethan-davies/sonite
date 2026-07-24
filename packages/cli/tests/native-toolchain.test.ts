import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isNativeBindingAvailable } from "@sonite/llvm";
import { linkNative, compileSourceFile } from "../src/native.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function makeScrubbedPath(): string {
  const scrub = mkdtempSync(join(tmpdir(), "sn-path-"));
  const candidates: Record<string, string[]> = {
    node: ["/usr/bin/node", process.execPath],
    env: ["/usr/bin/env"],
    sh: ["/bin/sh"],
    bash: ["/bin/bash"],
    "pkg-config": ["/usr/bin/pkg-config"],
  };
  for (const [name, paths] of Object.entries(candidates)) {
    for (const src of paths) {
      if (existsSync(src)) {
        try {
          symlinkSync(src, join(scrub, name));
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
  return scrub;
}

describe.runIf(isNativeBindingAvailable())("native toolchain pipeline", () => {
  it(
    "emits an object and links hello.sn",
    async () => {
      const compiled = compileSourceFile(join(repoRoot, "examples/hello.sn"));
      expect(compiled).not.toBeNull();
      const dir = mkdtempSync(join(tmpdir(), "sn-pipe-"));
      try {
        const status = await linkNative({
          ir: compiled!.ir,
          outputPath: join(dir, "hello"),
        });
        expect(status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "honors release opt policy via linkNative",
    async () => {
      const compiled = compileSourceFile(join(repoRoot, "examples/hello.sn"));
      expect(compiled).not.toBeNull();
      const dir = mkdtempSync(join(tmpdir(), "sn-rel-"));
      try {
        const status = await linkNative({
          ir: compiled!.ir,
          outputPath: join(dir, "hello"),
          release: true,
        });
        expect(status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "sn run works without clang/llc/ld.lld on PATH",
    () => {
      const scrub = makeScrubbedPath();
      try {
        for (const tool of ["clang", "llc", "ld.lld", "lld"]) {
          const probe = spawnSync(tool, ["--version"], {
            env: { ...process.env, PATH: scrub },
            encoding: "utf8",
          });
          expect(probe.status === 0 && !probe.error).toBe(false);
        }

        const result = spawnSync(
          process.execPath,
          [join(repoRoot, "packages/cli/dist/cli.js"), "run", "examples/hello.sn"],
          {
            cwd: repoRoot,
            env: { ...process.env, PATH: scrub },
            encoding: "utf8",
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Hello");
      } finally {
        rmSync(scrub, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
