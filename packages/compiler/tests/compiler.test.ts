import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { encodeLlvmString } from "../src/codegen/llvm.js";

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../examples");

const helloSource = `
function main(): void {
  print("Hello, world!");
}
`;

describe("compile pipeline", () => {
  describe("successful compilation", () => {
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

    it("compiles f32 annotations and float arithmetic", () => {
      const result = compile(`
        function main(): void {
          let a: f32 = 1.5;
          let b: f64 = 2.5;
          print(a);
          print(b + 1.0);
          print(b * 2.0);
          print(b / 2.0);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("%v.a = alloca float");
      expect(result.ir).toContain("%v.b = alloca double");
      expect(result.ir).toContain("fadd double");
      expect(result.ir).toContain("fmul double");
      expect(result.ir).toContain("fdiv double");
    });

    it("compiles arithmetic with precedence", () => {
      const result = compile(`
        function main(): void {
          print(2 + 3 * 4);
          print((2 + 3) * 4);
          print(10 / 3);
          print(10 % 3);
          print(-5);
          print(1 - 2);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("mul i32");
      expect(result.ir).toContain("add i32");
      expect(result.ir).toContain("sdiv i32");
      expect(result.ir).toContain("srem i32");
      expect(result.ir).toContain("sub i32 0,");
      expect(result.ir).toContain("sub i32");
    });

    it("compiles runtime string concatenation", () => {
      const result = compile(`
        function main(): void {
          let name = "world";
          print("Hello " + name);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("declare i64 @strlen");
      expect(result.ir).toContain("call ptr @malloc");
      expect(result.ir).toContain("call ptr @strcpy");
      expect(result.ir).toContain("call ptr @strcat");
    });

    it("compiles user-defined functions with parameters and calls", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          return a + b;
        }
        function main(): void {
          let x = add(2, 3) * (4 - 1);
          print(x);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i32 @add(i32 %arg0, i32 %arg1)");
      expect(result.ir).toContain("define i32 @main()");
      expect(result.ir).toContain("call i32 @add(i32 2, i32 3)");
      expect(result.ir).toContain("ret i32");
      expect(result.ir).toContain("mul i32");
      expect(result.ir).toContain("sub i32");
    });

    it("compiles void helpers and nested calls", () => {
      const result = compile(`
        function greet(name: string): void {
          print("Hello", name);
          return;
        }
        function double(n: i32): i32 {
          return n + n;
        }
        function main(): void {
          greet("Ada");
          print(double(double(2)));
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define void @greet(ptr %arg0)");
      expect(result.ir).toContain("call void @greet(ptr");
      expect(result.ir).toContain("define i32 @double(i32 %arg0)");
      expect(result.ir).toMatch(/call i32 @double\(i32 %t\d+\)/);
      expect(result.ir).toContain("ret void");
    });

    it("compiles i64 parameters and returns", () => {
      const result = compile(`
        function add64(a: i64, b: i64): i64 {
          return a + b;
        }
        function main(): void {
          let n: i64 = add64(10, 20);
          print(n);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("define i64 @add64(i64 %arg0, i64 %arg1)");
      expect(result.ir).toContain("call i64 @add64(i64 10, i64 20)");
      expect(result.ir).toContain("add i64");
    });

    it("compiles comparisons, logical ops, and boolean print", () => {
      const result = compile(`
        function main(): void {
          print(5 > 2);
          print(1 == 1);
          print(1.5 < 2.0);
          print(!true);
          print(true && false);
          print(true || false);
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("icmp sgt i32");
      expect(result.ir).toContain("icmp eq i32");
      expect(result.ir).toContain("fcmp olt double");
      expect(result.ir).toContain("xor i1");
      expect(result.ir).toContain("and i1");
      expect(result.ir).toContain("or i1");
      expect(result.ir).toContain(encodeLlvmString("true"));
      expect(result.ir).toContain(encodeLlvmString("false"));
      expect(result.ir).toContain("select i1");
    });

    it("compiles if / elseif / else branches", () => {
      const result = compile(`
        function main(): void {
          let age = 16;
          if (age >= 18) {
            print("Adult");
          } elseif (age >= 13) {
            print("Teen");
          } else {
            print("Minor");
          }
        }
      `);
      expect(result.success).toBe(true);
      expect(result.ir).toContain("icmp sge i32");
      expect(result.ir).toContain("br i1");
      expect(result.ir).toContain("then.0:");
      expect(result.ir).toContain("else.0:");
      expect(result.ir).toContain("merge.0:");
      expect(result.ir).toContain(encodeLlvmString("Adult"));
      expect(result.ir).toContain(encodeLlvmString("Teen"));
      expect(result.ir).toContain(encodeLlvmString("Minor"));
    });

    it("compiles the hello, variables, arithmetic, and control-flow examples", () => {
      for (const name of ["hello.tsn", "variables.tsn", "arithmetic.tsn", "control-flow.tsn"]) {
        const source = readFileSync(join(examplesDir, name), "utf8");
        const result = compile(source);
        expect(result.success, name).toBe(true);
        expect(result.ir, name).toContain("define i32 @main()");
      }
    });
  });

  describe("validation errors", () => {
    it("fails when main is missing", () => {
      const result = compile("");
      expect(result.success).toBe(false);
      expect(result.ir).toBeNull();
      expect(result.diagnostics.some((d) => d.code === "E0200")).toBe(true);
    });

    it("fails when only a non-main function exists", () => {
      const result = compile(`
        function greet(): void {
          print("hi");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0202")).toBe(true);
    });

    it("fails when more than one main exists", () => {
      const result = compile(`
        function main(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0201")).toBe(true);
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

    it("fails when main has parameters", () => {
      const result = compile(`
        function main(x: i32): void {
          print(x);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0206")).toBe(true);
    });
  });

  describe("typecheck errors", () => {
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

    it("fails on duplicate variable declarations", () => {
      const result = compile(`
        function main(): void {
          let x = 1;
          let x = 2;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0301")).toBe(true);
    });

    it("fails when void is used as a variable type", () => {
      const result = compile(`
        function main(): void {
          let x: void = 1;
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0302")).toBe(true);
    });

    it("fails on undefined variables", () => {
      const result = compile(`
        function main(): void {
          print(missing);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0304")).toBe(true);
    });

    it("fails on mismatched arithmetic operands", () => {
      const result = compile(`
        function main(): void {
          print(1 + "a");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails on mixed numeric widths in arithmetic", () => {
      const result = compile(`
        function main(): void {
          let a: i32 = 1;
          let b: i64 = 2;
          print(a + b);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails when print has no arguments", () => {
      const result = compile(`
        function main(): void {
          print();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0308")).toBe(true);
    });

    it("fails when print is used as a value", () => {
      const result = compile(`
        function main(): void {
          let x = print("hi");
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0309")).toBe(true);
    });

    it("fails when redefining the print builtin", () => {
      const result = compile(`
        function print(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0310")).toBe(true);
    });

    it("fails on duplicate function names", () => {
      const result = compile(`
        function helper(): void {}
        function helper(): void {}
        function main(): void {}
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0311")).toBe(true);
    });

    it("fails when a non-void function is missing a final return", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          let x = a + b;
        }
        function main(): void {
          print(add(1, 2));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0312")).toBe(true);
    });

    it("fails when a void function returns a value", () => {
      const result = compile(`
        function nope(): void {
          return 1;
        }
        function main(): void {
          nope();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0313")).toBe(true);
    });

    it("fails when a non-void function uses a bare return", () => {
      const result = compile(`
        function value(): i32 {
          return;
        }
        function main(): void {
          print(value());
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0314")).toBe(true);
    });

    it("fails on arity mismatches", () => {
      const result = compile(`
        function add(a: i32, b: i32): i32 {
          return a + b;
        }
        function main(): void {
          print(add(1));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0315")).toBe(true);
    });

    it("fails when a void function is used as a value", () => {
      const result = compile(`
        function greet(): void {
          print("hi");
        }
        function main(): void {
          let x = greet();
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0309")).toBe(true);
    });

    it("fails on argument type mismatches", () => {
      const result = compile(`
        function identity(x: i32): i32 {
          return x;
        }
        function main(): void {
          print(identity("nope"));
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0303")).toBe(true);
    });

    it("fails when if condition is not bool", () => {
      const result = compile(`
        function main(): void {
          if (1) {
            print("x");
          }
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0316")).toBe(true);
    });

    it("fails on mismatched comparison operands", () => {
      const result = compile(`
        function main(): void {
          print(1 > true);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });

    it("fails on non-bool logical operands", () => {
      const result = compile(`
        function main(): void {
          print(1 && true);
        }
      `);
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "E0306")).toBe(true);
    });
  });
});

describe("encodeLlvmString", () => {
  it("escapes non-printable bytes", () => {
    expect(encodeLlvmString("a\nb")).toBe("a\\0Ab");
    expect(encodeLlvmString('say "hi"')).toBe("say \\22hi\\22");
  });
});
