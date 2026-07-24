import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileFile } from "../src/index.js";

/**
 * Manual LLDB smoke (not run in CI):
 *   sn build
 *   lldb --batch -o 'b main' -o 'run' -o 'frame info' -o 'quit' .sonite/bin/<name>
 *
 * Optional object-level check when llvm-dwarfdump is on PATH:
 *   sn build --emit-ir && llc/backend emit + llvm-dwarfdump --debug-line
 */

describe("LLVM debug metadata", () => {
  it("emits DICompileUnit, DISubprogram, DILocation, and !dbg on main by default", () => {
    const result = compile(
      `function main(): void {
  print("hi");
}
`,
      { fileName: "debug-fixture.sn" },
    );
    expect(result.success).toBe(true);
    expect(result.ir).toBeTruthy();
    const ir = result.ir!;
    expect(ir).toContain("!DICompileUnit");
    expect(ir).toContain("!DISubprogram");
    expect(ir).toContain("!DILocation");
    expect(ir).toContain("!DIFile");
    expect(ir).toContain("!DILexicalBlock");
    expect(ir).toMatch(/define i32 @main\([^)]*\) !dbg !\d+ \{/);
    expect(ir).toContain("!llvm.dbg.cu");
    expect(ir).toContain("Debug Info Version");
    expect(ir).toMatch(/call void @sn_print[^\n]*, !dbg !\d+/);
  });

  it("omits debug metadata when debugInfo is false", () => {
    const result = compile(
      `function main(): void {
  print("hi");
}
`,
      { fileName: "release-fixture.sn", debugInfo: false },
    );
    expect(result.success).toBe(true);
    expect(result.ir).not.toContain("!DICompileUnit");
    expect(result.ir).not.toContain("!dbg !");
  });

  it("uses the real source path in DIFile / source_filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-debug-"));
    const file = join(dir, "app.sn");
    try {
      writeFileSync(
        file,
        `function main(): void {
  print("dbg");
}
`,
      );
      const result = compileFile(file);
      expect(result.success).toBe(true);
      const ir = result.ir!;
      expect(ir).toContain("app.sn");
      expect(ir).toMatch(/source_filename = ".*app\.sn"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits lexical scopes for if bodies", () => {
    const result = compile(
      `function main(): void {
  if (true) {
    print("then");
  }
}
`,
      { fileName: "lex.sn" },
    );
    expect(result.success).toBe(true);
    expect(result.ir).toContain("!DILexicalBlock");
  });
});
