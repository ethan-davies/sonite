import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Backend,
  Linker,
  PINNED_LLVM_VERSION,
  getDefaultTriple,
  getLlvmVersion,
  getLldVersion,
  isNativeBindingAvailable,
  resolveOptLevel,
} from "../src/index.js";

describe.runIf(isNativeBindingAvailable())("LLVM binding", () => {
  it("initializes and reports LLVM version", () => {
    const version = getLlvmVersion();
    expect(version.startsWith("22.1")).toBe(true);
    expect(PINNED_LLVM_VERSION.startsWith("22.1")).toBe(true);
    expect(getLldVersion().length).toBeGreaterThan(0);
  });

  it("looks up the default target triple", () => {
    const triple = getDefaultTriple();
    expect(triple).toMatch(/linux|darwin|apple|unknown/);
  });

  it("creates a TargetMachine and emits an object file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-llvm-"));
    const obj = join(dir, "main.o");
    const ir = [
      "; ModuleID = 't'",
      'source_filename = "t"',
      "define i32 @main() {",
      "  ret i32 0",
      "}",
      "",
    ].join("\n");

    const backend = Backend.fromIr(ir);
    try {
      backend.target({ optLevel: "O0" });
      backend.verify();
      backend.emitObject(obj);
      expect(existsSync(obj)).toBe(true);
      expect(backend.getTriple().length).toBeGreaterThan(0);
    } finally {
      backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid IR verification", () => {
    // Parses successfully but fails dominance checks in the verifier.
    const ir = [
      "; ModuleID = 'bad'",
      'source_filename = "bad"',
      "define i32 @main() {",
      "entry:",
      "  br label %next",
      "next:",
      "  %x = add i32 %y, 1",
      "  %y = add i32 1, 2",
      "  ret i32 %x",
      "}",
      "",
    ].join("\n");
    const backend = Backend.fromIr(ir);
    try {
      backend.target({ optLevel: "O0" });
      expect(() => backend.verify()).toThrow(/LLVM IR verification failed/);
    } finally {
      backend.dispose();
    }
  });

  it("releases native resources via dispose", () => {
    const backend = Backend.fromIr(
      "; ModuleID = 'd'\nsource_filename = \"d\"\ndefine void @f() { ret void }\n",
    );
    backend.dispose();
    expect(() => backend.verify()).toThrow(/disposed/);
  });
});

describe("opt policy", () => {
  it("maps release and explicit levels", () => {
    expect(resolveOptLevel()).toBe("O0");
    expect(resolveOptLevel({ release: true })).toBe("O2");
    expect(resolveOptLevel({ optLevel: "O3" })).toBe("O3");
    expect(resolveOptLevel({ release: true, optLevel: "O1" })).toBe("O1");
  });
});

describe.runIf(isNativeBindingAvailable())("LLD linker", () => {
  it("links a trivial executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-lld-"));
    const obj = join(dir, "main.o");
    const bin = join(dir, "main");
    const ir = [
      "; ModuleID = 'link'",
      'source_filename = "link"',
      "define i32 @main() {",
      "  ret i32 0",
      "}",
      "",
    ].join("\n");

    const backend = Backend.fromIr(ir);
    const linker = Linker.forHost();
    try {
      backend.target({ optLevel: "O0" });
      backend.verify();
      backend.emitObject(obj);
      linker.addObject(obj);
      linker.addDefaultSystemLibraries();
      linker.setOutput(bin);
      linker.link();
      expect(existsSync(bin)).toBe(true);
    } finally {
      backend.dispose();
      linker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(isNativeBindingAvailable() && process.platform === "linux")(
  "self-contained packaging",
  () => {
    it("does not resolve libLLVM from /usr/lib", async () => {
      const { spawnSync } = await import("node:child_process");
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { existsSync } = await import("node:fs");
      const addon = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../llvm-linux-x64/native/sonite_llvm.node",
      );
      if (!existsSync(addon)) {
        return;
      }
      const r = spawnSync("ldd", [addon], { encoding: "utf8" });
      expect(r.status).toBe(0);
      for (const line of (r.stdout || "").split("\n")) {
        if (!/libLLVM|liblld/.test(line)) continue;
        expect(line).toMatch(/llvm-linux-x64/);
        expect(line).not.toMatch(/=> \/usr\/lib\//);
      }
    });
  },
);
