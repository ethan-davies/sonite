import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Permanent reproducers for compiler ICEs discovered by fuzzing or audits.
 * Layout: tests/crash-regressions/<id>/input.sn
 *
 * Invariant: compile(input) must not throw. Diagnostics/failure are OK.
 */

const regressionsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "crash-regressions",
);

function listRegressionIds(): string[] {
  if (!existsSync(regressionsRoot)) {
    return [];
  }
  return readdirSync(regressionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(regressionsRoot, name, "input.sn")))
    .sort();
}

describe("crash regressions", () => {
  const ids = listRegressionIds();

  if (ids.length === 0) {
    it("has a regressions directory ready for ICE reproducers", () => {
      mkdirSync(regressionsRoot, { recursive: true });
      expect(existsSync(regressionsRoot)).toBe(true);
    });
    return;
  }

  for (const id of ids) {
    it(`does not ICE on ${id}`, () => {
      const source = readFileSync(join(regressionsRoot, id, "input.sn"), "utf8");
      let threw: unknown = null;
      try {
        const result = compile(source, {
          fileName: `${id}.sn`,
          debugInfo: false,
        });
        expect(typeof result.success).toBe("boolean");
      } catch (error) {
        threw = error;
      }
      expect(threw, `ICE on crash-regressions/${id}/input.sn`).toBeNull();
    });
  }
});

/** Helper used when promoting a fuzz failure — writes a new fixture directory. */
export function writeCrashRegression(id: string, source: string): string {
  const dir = join(regressionsRoot, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "input.sn");
  writeFileSync(path, source, "utf8");
  return path;
}
