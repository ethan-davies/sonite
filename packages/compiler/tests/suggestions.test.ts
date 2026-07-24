import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compile,
  compileFile,
  editDistance,
  formatDiagnostics,
  suggestClosest,
} from "../src/index.js";

describe("suggestClosest", () => {
  it("suggests a unique close match", () => {
    expect(suggestClosest("usr", ["user", "admin", "guest"])).toEqual(["user"]);
  });

  it("suggests case-fold matches", () => {
    expect(suggestClosest("User", ["user", "admin"])).toEqual(["user"]);
  });

  it("suppresses suggestions when best distance is a tie", () => {
    expect(suggestClosest("foox", ["fooy", "fooz", "bar"])).toEqual([]);
  });

  it("suppresses suggestions when distance is too large", () => {
    expect(suggestClosest("abcdef", ["xyz", "qqq", "zzz"])).toEqual([]);
  });

  it("computes edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("user", "usr")).toBe(1);
  });
});

describe("diagnostic suggestions", () => {
  it("suggests a nearby identifier for undefined variables", () => {
    const result = compile(`
function main(): void {
  const user = 1;
  print(usr);
}
`);
    expect(result.success).toBe(false);
    const undef = result.diagnostics.find((d) => d.code === "E0304");
    expect(undef).toBeDefined();
    expect(undef?.suggestions).toEqual(["user"]);
    const formatted = formatDiagnostics(result.diagnostics);
    expect(formatted).toContain("Did you mean 'user'?");
  });

  it("suggests a nearby type name", () => {
    const result = compile(`
struct Point {
  x: i32;
  y: i32;
}

function take(p: Pont): void {
  print(1);
}

function main(): void {
  take(Point { x: 1, y: 2 });
}
`);
    expect(result.success).toBe(false);
    const unknown = result.diagnostics.find((d) => d.code === "E0104");
    expect(unknown).toBeDefined();
    expect(unknown?.suggestions).toEqual(["Point"]);
  });

  it("does not suggest when the typo is far from all names", () => {
    const result = compile(`
function main(): void {
  const alpha = 1;
  print(zzzzzzzz);
}
`);
    expect(result.success).toBe(false);
    const undef = result.diagnostics.find((d) => d.code === "E0304");
    expect(undef).toBeDefined();
    expect(undef?.suggestions ?? []).toEqual([]);
  });

  it("suggests a nearby std module path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-suggest-mod-"));
    try {
      writeFileSync(
        join(dir, "main.sn"),
        `import { sqrt } from "std/mathh";

function main(): void {
  print(sqrt(4.0));
}
`,
      );
      const result = compileFile(join(dir, "main.sn"));
      expect(result.success).toBe(false);
      const missing = result.diagnostics.find((d) => d.code === "E0401");
      expect(missing).toBeDefined();
      expect(missing?.suggestions).toEqual(["std/math"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suggests a nearby relative module", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-suggest-rel-"));
    try {
      writeFileSync(join(dir, "helper.sn"), `export function n(): i32 { return 1; }\n`);
      writeFileSync(
        join(dir, "main.sn"),
        `import { n } from "./helpr";

function main(): void {
  print(n());
}
`,
      );
      const result = compileFile(join(dir, "main.sn"));
      expect(result.success).toBe(false);
      const missing = result.diagnostics.find((d) => d.code === "E0401");
      expect(missing).toBeDefined();
      expect(missing?.suggestions).toEqual(["./helper"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
