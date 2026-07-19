import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { encodeLlvmString } from "../src/codegen/llvm.js";

const helloSource = `
function main(): void {
  print("Hello, world!");
}
`;

describe("compile pipeline", () => {
  it("compiles hello world to LLVM IR with printf", () => {
    const result = compile(helloSource);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("declare i32 @printf");
    expect(result.ir).toContain("define i32 @main()");
    expect(result.ir).toContain("call i32 (ptr, ...) @printf");
    expect(result.ir).toContain(encodeLlvmString("Hello, world!"));
    expect(result.ir).toContain("%s\\0A");
    expect(result.ast.body[0]?.name.name).toBe("main");
  });

  it("allows changing the printed string", () => {
    const result = compile(`
      function main(): void {
        print("changed");
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain(encodeLlvmString("changed"));
    expect(result.ir).not.toContain(encodeLlvmString("Hello, world!"));
  });

  it("emits multiple printf calls for multiple prints", () => {
    const result = compile(`
      function main(): void {
        print("a");
        print("b");
      }
    `);
    expect(result.success).toBe(true);
    const calls = result.ir?.match(/call i32 \(ptr, \.\.\.\) @printf/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("compiles variables, inference, and concat", () => {
    const result = compile(`
      function main(): void {
        let x = 42;
        const pi = 3.14;
        let n: i64 = 100;
        let ok = true;
        let c: char = 'a';
        let s = "hi";
        x = 10;
        print(42);
        print(x);
        print("Hello " + "world");
        print("Hello", "world");
        print(ok);
        print(c);
        print(s);
        print(pi);
        print(n);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.ir).toContain("%v.x = alloca i32");
    expect(result.ir).toContain("%v.pi = alloca double");
    expect(result.ir).toContain("%v.n = alloca i64");
    expect(result.ir).toContain("%v.ok = alloca i1");
    expect(result.ir).toContain("%v.c = alloca i8");
    expect(result.ir).toContain("%v.s = alloca ptr");
    expect(result.ir).toContain(encodeLlvmString("Hello world"));
    expect(result.ir).toContain("%s %s\\0A");
  });

  it("fails when main is missing", () => {
    const result = compile("");
    expect(result.success).toBe(false);
    expect(result.ir).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "E0200")).toBe(true);
  });

  it("fails when the function is not named main", () => {
    const result = compile(`
      function greet(): void {
        print("hi");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0202")).toBe(true);
  });

  it("fails when main does not return void", () => {
    const result = compile(`
      function main(): i32 {
        print("hi");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0205")).toBe(true);
  });

  it("fails on unknown function calls", () => {
    const result = compile(`
      function main(): void {
        other("x");
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0307")).toBe(true);
  });

  it("fails on const reassignment", () => {
    const result = compile(`
      function main(): void {
        const x = 1;
        x = 2;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0305")).toBe(true);
  });

  it("fails on type annotation mismatch", () => {
    const result = compile(`
      function main(): void {
        let x: string = 42;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
  });
});

describe("encodeLlvmString", () => {
  it("escapes non-printable bytes", () => {
    expect(encodeLlvmString("a\nb")).toBe("a\\0Ab");
    expect(encodeLlvmString('say "hi"')).toBe("say \\22hi\\22");
  });
});
