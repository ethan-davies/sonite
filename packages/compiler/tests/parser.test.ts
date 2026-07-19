import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../src/diagnostics/index.js";
import { Lexer } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";

function parse(source: string) {
  const diagnostics = new DiagnosticCollector();
  const tokens = new Lexer(source, diagnostics).tokenize();
  const ast = new Parser(tokens, diagnostics).parse();
  return { ast, diagnostics };
}

describe("Parser", () => {
  it("parses main with a return type and print statement", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        print("hi");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body).toHaveLength(1);
    expect(ast.body[0]?.name.name).toBe("main");
    expect(ast.body[0]?.returnType.name).toBe("void");
    expect(ast.body[0]?.body).toHaveLength(1);

    const stmt = ast.body[0]?.body[0];
    expect(stmt?.kind).toBe("ExpressionStatement");
    if (stmt?.kind !== "ExpressionStatement") {
      return;
    }
    const call = stmt.expression;
    expect(call.kind).toBe("CallExpression");
    if (call.kind !== "CallExpression") {
      return;
    }
    expect(call.callee.name).toBe("print");
    expect(call.args[0]).toMatchObject({
      kind: "StringLiteral",
      value: "hi",
    });
  });

  it("parses let/const, assignment, and multi-arg print", () => {
    const { ast, diagnostics } = parse(`
      function main(): void {
        let x = 42;
        const s: string = "hi";
        x = 10;
        print("Hello", "world");
        print("a" + "b");
      }
    `);
    expect(diagnostics.hasErrors).toBe(false);
    const body = ast.body[0]?.body ?? [];
    expect(body).toHaveLength(5);
    expect(body[0]?.kind).toBe("VariableDeclaration");
    expect(body[1]?.kind).toBe("VariableDeclaration");
    expect(body[2]?.kind).toBe("AssignmentStatement");
    expect(body[3]?.kind).toBe("ExpressionStatement");
    expect(body[4]?.kind).toBe("ExpressionStatement");

    if (body[0]?.kind === "VariableDeclaration") {
      expect(body[0].mutability).toBe("let");
      expect(body[0].initializer.kind).toBe("IntegerLiteral");
    }
    if (body[4]?.kind === "ExpressionStatement" && body[4].expression.kind === "CallExpression") {
      const arg = body[4].expression.args[0];
      expect(arg?.kind).toBe("BinaryExpression");
    }
  });

  it("parses an empty main body", () => {
    const { ast, diagnostics } = parse("function main(): void {}");
    expect(diagnostics.hasErrors).toBe(false);
    expect(ast.body[0]?.body).toEqual([]);
  });

  it("rejects missing return type", () => {
    const { diagnostics } = parse(`
      function main() {
        print("x");
      }
    `);
    expect(diagnostics.hasErrors).toBe(true);
  });

  it("rejects missing parentheses", () => {
    const { diagnostics } = parse('function main: void { print("x"); }');
    expect(diagnostics.hasErrors).toBe(true);
  });
});
