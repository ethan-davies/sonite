import type {
  Expression,
  FunctionDeclaration,
  PrimitiveTypeName,
  Program,
  Statement,
} from "./ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "./diagnostics/diagnostic.js";

export type ValueType = Exclude<PrimitiveTypeName, "void">;

interface Binding {
  readonly type: ValueType;
  readonly mutable: boolean;
}

interface FunctionSig {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: PrimitiveTypeName;
  readonly decl: FunctionDeclaration;
}

const NUMERIC_TYPES = new Set<ValueType>(["i32", "i64", "f32", "f64"]);

/**
 * Type-check a validated program: inference, annotations, arithmetic, calls, returns.
 */
export function typecheck(program: Program, diagnostics: DiagnosticCollector): void {
  const functions = new Map<string, FunctionSig>();

  for (const fn of program.body) {
    if (fn.name.name === "print") {
      diagnostics.error(
        "Cannot redefine builtin function 'print'",
        fn.name.span,
        "E0310",
      );
      continue;
    }

    if (functions.has(fn.name.name)) {
      diagnostics.error(
        `Duplicate function '${fn.name.name}'`,
        fn.name.span,
        "E0311",
      );
      continue;
    }

    const params: ValueType[] = [];
    let paramsOk = true;
    for (const param of fn.params) {
      if (param.typeAnnotation.name === "void") {
        diagnostics.error(
          "'void' cannot be used as a parameter type",
          param.typeAnnotation.span,
          "E0302",
        );
        paramsOk = false;
        continue;
      }
      params.push(param.typeAnnotation.name);
    }

    if (!paramsOk) {
      continue;
    }

    functions.set(fn.name.name, {
      name: fn.name.name,
      params,
      returnType: fn.returnType.name,
      decl: fn,
    });
  }

  for (const fn of program.body) {
    checkFunction(fn, functions, diagnostics);
  }
}

function checkFunction(
  fn: FunctionDeclaration,
  functions: Map<string, FunctionSig>,
  diagnostics: DiagnosticCollector,
): void {
  const scope = new Map<string, Binding>();

  for (const param of fn.params) {
    if (param.typeAnnotation.name === "void") {
      continue;
    }
    if (scope.has(param.name.name)) {
      diagnostics.error(
        `Duplicate parameter '${param.name.name}'`,
        param.name.span,
        "E0301",
      );
      continue;
    }
    scope.set(param.name.name, {
      type: param.typeAnnotation.name,
      mutable: false,
    });
  }

  for (const stmt of fn.body) {
    checkStatement(stmt, scope, functions, fn.returnType.name, diagnostics);
  }

  if (fn.returnType.name !== "void") {
    const last = fn.body[fn.body.length - 1];
    if (!last || last.kind !== "ReturnStatement" || last.value === null) {
      diagnostics.error(
        `Function '${fn.name.name}' must end with a return statement`,
        fn.name.span,
        "E0312",
      );
    }
  }
}

function checkStatement(
  stmt: Statement,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  returnType: PrimitiveTypeName,
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

      const inferred = checkExpression(stmt.initializer, scope, functions, diagnostics);
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
      const valueType = checkExpression(stmt.value, scope, functions, diagnostics);
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
      checkExpression(stmt.expression, scope, functions, diagnostics, true);
      return;
    }
    case "ReturnStatement": {
      if (returnType === "void") {
        if (stmt.value !== null) {
          diagnostics.error(
            "Void function cannot return a value",
            stmt.value.span,
            "E0313",
          );
        }
        return;
      }

      if (stmt.value === null) {
        diagnostics.error(
          `Function must return a value of type '${returnType}'`,
          stmt.span,
          "E0314",
        );
        return;
      }

      const valueType = checkExpression(stmt.value, scope, functions, diagnostics);
      if (!valueType) {
        return;
      }
      if (!valueMatchesBinding(stmt.value, valueType, returnType as ValueType)) {
        diagnostics.error(
          `Type mismatch: expected '${returnType}', got '${valueType}'`,
          stmt.value.span,
          "E0303",
        );
      }
      return;
    }
    case "IfStatement": {
      const condType = checkExpression(stmt.condition, scope, functions, diagnostics);
      if (condType && condType !== "bool") {
        diagnostics.error(
          `If condition must be 'bool', got '${condType}'`,
          stmt.condition.span,
          "E0316",
        );
      }
      for (const s of stmt.consequent) {
        checkStatement(s, scope, functions, returnType, diagnostics);
      }
      if (stmt.alternate === null) {
        return;
      }
      if (Array.isArray(stmt.alternate)) {
        for (const s of stmt.alternate) {
          checkStatement(s, scope, functions, returnType, diagnostics);
        }
      } else {
        checkStatement(stmt.alternate, scope, functions, returnType, diagnostics);
      }
      return;
    }
  }
}

function checkExpression(
  expr: Expression,
  scope: Map<string, Binding>,
  functions: Map<string, FunctionSig>,
  diagnostics: DiagnosticCollector,
  allowVoidCall = false,
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
    case "UnaryExpression": {
      const operand = checkExpression(expr.operand, scope, functions, diagnostics);
      if (!operand) {
        return null;
      }
      if (expr.operator === "!") {
        if (operand !== "bool") {
          diagnostics.error(
            `Operator '!' requires a bool operand, got '${operand}'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        return "bool";
      }
      if (!NUMERIC_TYPES.has(operand)) {
        diagnostics.error(
          `Operator '-' requires a numeric operand, got '${operand}'`,
          expr.span,
          "E0306",
        );
        return null;
      }
      return operand;
    }
    case "BinaryExpression": {
      const left = checkExpression(expr.left, scope, functions, diagnostics);
      const right = checkExpression(expr.right, scope, functions, diagnostics);
      if (!left || !right) {
        return null;
      }

      if (expr.operator === "&&" || expr.operator === "||") {
        if (left !== "bool" || right !== "bool") {
          diagnostics.error(
            `Operator '${expr.operator}' requires two bool operands, got '${left}' and '${right}'`,
            expr.span,
            "E0306",
          );
          return null;
        }
        return "bool";
      }

      if (
        expr.operator === "==" ||
        expr.operator === "!=" ||
        expr.operator === "<" ||
        expr.operator === "<=" ||
        expr.operator === ">" ||
        expr.operator === ">="
      ) {
        return checkComparison(expr.operator, left, right, expr.span, diagnostics);
      }

      if (expr.operator === "+") {
        if (left === "string" && right === "string") {
          return "string";
        }
        if (NUMERIC_TYPES.has(left) && left === right) {
          return left;
        }
        diagnostics.error(
          `Operator '+' requires two string or two matching numeric operands, got '${left}' and '${right}'`,
          expr.span,
          "E0306",
        );
        return null;
      }

      if (!NUMERIC_TYPES.has(left) || left !== right) {
        diagnostics.error(
          `Operator '${expr.operator}' requires two matching numeric operands, got '${left}' and '${right}'`,
          expr.span,
          "E0306",
        );
        return null;
      }
      return left;
    }
    case "CallExpression": {
      if (expr.callee.name === "print") {
        if (!allowVoidCall) {
          diagnostics.error("'print' cannot be used as a value", expr.span, "E0309");
          return null;
        }
        if (expr.args.length === 0) {
          diagnostics.error("'print' requires at least one argument", expr.span, "E0308");
          return null;
        }
        for (const arg of expr.args) {
          const argType = checkExpression(arg, scope, functions, diagnostics);
          if (!argType) {
            return null;
          }
        }
        return null;
      }

      const sig = functions.get(expr.callee.name);
      if (!sig) {
        diagnostics.error(
          `Unknown function '${expr.callee.name}'`,
          expr.callee.span,
          "E0307",
        );
        return null;
      }

      if (expr.args.length !== sig.params.length) {
        diagnostics.error(
          `Function '${sig.name}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
          expr.span,
          "E0315",
        );
        return null;
      }

      for (let i = 0; i < expr.args.length; i += 1) {
        const arg = expr.args[i]!;
        const expected = sig.params[i]!;
        const argType = checkExpression(arg, scope, functions, diagnostics);
        if (!argType) {
          return null;
        }
        if (!valueMatchesBinding(arg, argType, expected)) {
          diagnostics.error(
            `Type mismatch: expected '${expected}', got '${argType}'`,
            arg.span,
            "E0303",
          );
          return null;
        }
      }

      if (sig.returnType === "void") {
        if (!allowVoidCall) {
          diagnostics.error(
            `Void function '${sig.name}' cannot be used as a value`,
            expr.span,
            "E0309",
          );
        }
        return null;
      }

      return sig.returnType;
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

function checkComparison(
  operator: "==" | "!=" | "<" | "<=" | ">" | ">=",
  left: ValueType,
  right: ValueType,
  span: SourceSpan,
  diagnostics: DiagnosticCollector,
): ValueType | null {
  if (left !== right) {
    diagnostics.error(
      `Operator '${operator}' requires matching operand types, got '${left}' and '${right}'`,
      span,
      "E0306",
    );
    return null;
  }

  const isEquality = operator === "==" || operator === "!=";
  if (isEquality) {
    if (NUMERIC_TYPES.has(left) || left === "bool" || left === "char") {
      return "bool";
    }
    diagnostics.error(
      `Operator '${operator}' is not supported for type '${left}'`,
      span,
      "E0306",
    );
    return null;
  }

  if (!NUMERIC_TYPES.has(left)) {
    diagnostics.error(
      `Operator '${operator}' requires two matching numeric operands, got '${left}' and '${right}'`,
      span,
      "E0306",
    );
    return null;
  }
  return "bool";
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
