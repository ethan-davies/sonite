import type {
  Expression,
  PrimitiveTypeName,
  Program,
  Statement,
} from "./ast/nodes.js";
import type { DiagnosticCollector } from "./diagnostics/diagnostic.js";

export type ValueType = Exclude<PrimitiveTypeName, "void">;

interface Binding {
  readonly type: ValueType;
  readonly mutable: boolean;
}

/**
 * Type-check a validated program: inference, annotations, print, and string +.
 */
export function typecheck(program: Program, diagnostics: DiagnosticCollector): void {
  const fn = program.body[0];
  if (!fn) {
    return;
  }

  const scope = new Map<string, Binding>();

  for (const stmt of fn.body) {
    checkStatement(stmt, scope, diagnostics);
  }
}

function checkStatement(
  stmt: Statement,
  scope: Map<string, Binding>,
  diagnostics: DiagnosticCollector,
): void {
  switch (stmt.kind) {
    case "VariableDeclaration": {
      if (scope.has(stmt.name.name)) {
        diagnostics.error(
          `Variable '${stmt.name.name}' is already declared`,
          stmt.name.span,
          "E0301",
        );
        return;
      }

      if (stmt.typeAnnotation?.name === "void") {
        diagnostics.error("'void' cannot be used as a variable type", stmt.typeAnnotation.span, "E0302");
        return;
      }

      const inferred = checkExpression(stmt.initializer, scope, diagnostics);
      if (!inferred) {
        return;
      }

      let bindingType: ValueType = inferred;
      if (stmt.typeAnnotation) {
        const annotated = stmt.typeAnnotation.name as ValueType;
        if (!initializerMatchesAnnotation(stmt.initializer, inferred, annotated)) {
          diagnostics.error(
            `Type mismatch: expected '${annotated}', got '${inferred}'`,
            stmt.initializer.span,
            "E0303",
          );
          return;
        }
        bindingType = annotated;
      }

      scope.set(stmt.name.name, {
        type: bindingType,
        mutable: stmt.mutability === "let",
      });
      return;
    }
    case "AssignmentStatement": {
      const binding = scope.get(stmt.name.name);
      if (!binding) {
        diagnostics.error(`Undefined variable '${stmt.name.name}'`, stmt.name.span, "E0304");
        return;
      }
      if (!binding.mutable) {
        diagnostics.error(
          `Cannot assign to const variable '${stmt.name.name}'`,
          stmt.name.span,
          "E0305",
        );
        return;
      }
      const valueType = checkExpression(stmt.value, scope, diagnostics);
      if (!valueType) {
        return;
      }
      if (!valueMatchesBinding(stmt.value, valueType, binding.type)) {
        diagnostics.error(
          `Type mismatch: expected '${binding.type}', got '${valueType}'`,
          stmt.value.span,
          "E0303",
        );
      }
      return;
    }
    case "ExpressionStatement": {
      checkExpression(stmt.expression, scope, diagnostics, true);
      return;
    }
  }
}

function checkExpression(
  expr: Expression,
  scope: Map<string, Binding>,
  diagnostics: DiagnosticCollector,
  allowPrint = false,
): ValueType | null {
  switch (expr.kind) {
    case "IntegerLiteral":
      return "i32";
    case "FloatLiteral":
      return "f64";
    case "BooleanLiteral":
      return "bool";
    case "StringLiteral":
      return "string";
    case "CharLiteral":
      return "char";
    case "Identifier": {
      const binding = scope.get(expr.name);
      if (!binding) {
        diagnostics.error(`Undefined variable '${expr.name}'`, expr.span, "E0304");
        return null;
      }
      return binding.type;
    }
    case "BinaryExpression": {
      const left = checkExpression(expr.left, scope, diagnostics);
      const right = checkExpression(expr.right, scope, diagnostics);
      if (!left || !right) {
        return null;
      }
      if (expr.operator === "+") {
        if (left !== "string" || right !== "string") {
          diagnostics.error(
            "Operator '+' requires string operands",
            expr.span,
            "E0306",
          );
          return null;
        }
        return "string";
      }
      return null;
    }
    case "CallExpression": {
      if (expr.callee.name !== "print") {
        diagnostics.error(
          `Unknown function '${expr.callee.name}'`,
          expr.callee.span,
          "E0307",
        );
        return null;
      }
      if (!allowPrint) {
        diagnostics.error("'print' cannot be used as a value", expr.span, "E0309");
        return null;
      }
      if (expr.args.length === 0) {
        diagnostics.error("'print' requires at least one argument", expr.span, "E0308");
        return null;
      }
      for (const arg of expr.args) {
        const argType = checkExpression(arg, scope, diagnostics);
        if (!argType) {
          return null;
        }
      }
      return null;
    }
  }
}

/** Integer/float literals may be annotated as any integer/float width. */
function initializerMatchesAnnotation(
  initializer: Expression,
  inferred: ValueType,
  annotated: ValueType,
): boolean {
  return valueMatchesBinding(initializer, inferred, annotated);
}

function valueMatchesBinding(
  value: Expression,
  inferred: ValueType,
  expected: ValueType,
): boolean {
  if (inferred === expected) {
    return true;
  }
  if (value.kind === "IntegerLiteral" && (expected === "i32" || expected === "i64")) {
    return true;
  }
  if (value.kind === "FloatLiteral" && (expected === "f32" || expected === "f64")) {
    return true;
  }
  return false;
}
