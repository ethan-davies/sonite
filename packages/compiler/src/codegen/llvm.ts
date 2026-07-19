import type {
  AssignmentStatement,
  BinaryExpression,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Parameter,
  Program,
  ReturnStatement,
  Statement,
  UnaryExpression,
  VariableDeclaration,
} from "../ast/nodes.js";
import type { ValueType } from "../typecheck.js";

interface LocalBinding {
  readonly ptr: string;
  readonly type: ValueType;
}

interface EmittedValue {
  readonly llvm: string;
  readonly type: ValueType;
}

interface FunctionSig {
  readonly name: string;
  readonly params: ValueType[];
  readonly returnType: ValueType | "void";
}

/**
 * Lowers a validated, type-checked AST to LLVM IR text.
 */
export class LlvmCodegen {
  private stringCounter = 0;
  private tempCounter = 0;
  private readonly stringGlobals = new Map<string, { name: string; length: number }>();
  private locals = new Map<string, LocalBinding>();
  private functions = new Map<string, FunctionSig>();
  private needsPrintf = false;
  private needsStringRuntime = false;
  private readonly functionBodies: string[] = [];

  emit(program: Program): string {
    this.stringCounter = 0;
    this.tempCounter = 0;
    this.stringGlobals.clear();
    this.locals = new Map();
    this.functions.clear();
    this.needsPrintf = false;
    this.needsStringRuntime = false;
    this.functionBodies.length = 0;

    for (const fn of program.body) {
      this.functions.set(fn.name.name, {
        name: fn.name.name,
        params: fn.params.map((p) => p.typeAnnotation.name as ValueType),
        returnType: fn.returnType.name === "void" ? "void" : fn.returnType.name,
      });
    }

    for (const fn of program.body) {
      this.emitFunction(fn);
    }

    const globalLines = this.emitStringGlobals();
    const declares: string[] = [];
    if (this.needsPrintf) {
      declares.push("declare i32 @printf(ptr noundef, ...) nounwind");
    }
    if (this.needsStringRuntime) {
      declares.push("declare i64 @strlen(ptr noundef) nounwind");
      declares.push("declare ptr @malloc(i64 noundef) nounwind");
      declares.push("declare ptr @strcpy(ptr noundef, ptr noundef) nounwind");
      declares.push("declare ptr @strcat(ptr noundef, ptr noundef) nounwind");
    }

    return [
      "; ModuleID = 'typescript-native'",
      'source_filename = "typescript-native"',
      "",
      ...globalLines,
      globalLines.length > 0 ? "" : null,
      ...declares,
      declares.length > 0 ? "" : null,
      ...this.functionBodies,
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private emitFunction(fn: FunctionDeclaration): void {
    this.locals = new Map();
    this.tempCounter = 0;
    const lines: string[] = [];

    const isMain = fn.name.name === "main";
    const header = isMain
      ? "define i32 @main() {"
      : this.emitFunctionHeader(fn);

    lines.push(header);
    lines.push("entry:");

    if (!isMain) {
      for (let i = 0; i < fn.params.length; i += 1) {
        this.emitParameter(fn.params[i]!, i, lines);
      }
    }

    let terminated = false;
    for (const stmt of fn.body) {
      if (terminated) {
        break;
      }
      terminated = this.emitStatement(stmt, lines);
    }

    if (!terminated) {
      if (isMain || fn.returnType.name === "void") {
        lines.push(isMain ? "  ret i32 0" : "  ret void");
      } else {
        throw new Error(`Codegen: non-void function '${fn.name.name}' missing return`);
      }
    }

    lines.push("}");
    lines.push("");
    this.functionBodies.push(...lines);
  }

  private emitFunctionHeader(fn: FunctionDeclaration): string {
    const ret = fn.returnType.name === "void" ? "void" : toLlvmType(fn.returnType.name);
    const params = fn.params
      .map((p, i) => `${toLlvmType(p.typeAnnotation.name as ValueType)} %arg${i}`)
      .join(", ");
    return `define ${ret} @${fn.name.name}(${params}) {`;
  }

  private emitParameter(param: Parameter, index: number, lines: string[]): void {
    const type = param.typeAnnotation.name as ValueType;
    const llvmType = toLlvmType(type);
    const ptr = `%v.${param.name.name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    lines.push(`  store ${llvmType} %arg${index}, ptr ${ptr}`);
    this.locals.set(param.name.name, { ptr, type });
  }

  /** Returns true if the statement terminates the block (return). */
  private emitStatement(stmt: Statement, lines: string[]): boolean {
    switch (stmt.kind) {
      case "VariableDeclaration":
        this.emitVariableDeclaration(stmt, lines);
        return false;
      case "AssignmentStatement":
        this.emitAssignment(stmt, lines);
        return false;
      case "ExpressionStatement":
        if (stmt.expression.kind === "CallExpression") {
          this.emitCallStatement(stmt.expression, lines);
        }
        return false;
      case "ReturnStatement":
        this.emitReturn(stmt, lines);
        return true;
    }
  }

  private emitVariableDeclaration(stmt: VariableDeclaration, lines: string[]): void {
    const type = this.resolveDeclType(stmt);
    const llvmType = toLlvmType(type);
    const ptr = `%v.${stmt.name.name}`;
    lines.push(`  ${ptr} = alloca ${llvmType}`);
    this.locals.set(stmt.name.name, { ptr, type });

    const init = this.emitExpression(stmt.initializer, lines, type);
    lines.push(`  store ${llvmType} ${init.llvm}, ptr ${ptr}`);
  }

  private emitAssignment(stmt: AssignmentStatement, lines: string[]): void {
    const local = this.locals.get(stmt.name.name);
    if (!local) {
      throw new Error(`Codegen: unknown variable '${stmt.name.name}'`);
    }
    const value = this.emitExpression(stmt.value, lines, local.type);
    lines.push(`  store ${toLlvmType(local.type)} ${value.llvm}, ptr ${local.ptr}`);
  }

  private emitReturn(stmt: ReturnStatement, lines: string[]): void {
    if (stmt.value === null) {
      lines.push("  ret void");
      return;
    }
    const value = this.emitExpression(stmt.value, lines);
    lines.push(`  ret ${toLlvmType(value.type)} ${value.llvm}`);
  }

  private emitCallStatement(call: CallExpression, lines: string[]): void {
    if (call.callee.name === "print") {
      this.emitPrintCall(call, lines);
      return;
    }
    this.emitUserCall(call, lines, true);
  }

  private resolveDeclType(stmt: VariableDeclaration): ValueType {
    if (stmt.typeAnnotation && stmt.typeAnnotation.name !== "void") {
      return stmt.typeAnnotation.name;
    }
    return this.inferExpressionType(stmt.initializer);
  }

  private inferExpressionType(expr: Expression): ValueType {
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
        const local = this.locals.get(expr.name);
        if (!local) {
          throw new Error(`Codegen: unknown variable '${expr.name}'`);
        }
        return local.type;
      }
      case "UnaryExpression":
        return this.inferExpressionType(expr.operand);
      case "BinaryExpression": {
        if (expr.operator === "+") {
          const left = this.inferExpressionType(expr.left);
          if (left === "string") {
            return "string";
          }
          return left;
        }
        return this.inferExpressionType(expr.left);
      }
      case "CallExpression": {
        const sig = this.functions.get(expr.callee.name);
        if (!sig || sig.returnType === "void") {
          throw new Error(`Codegen: unexpected call in type inference '${expr.callee.name}'`);
        }
        return sig.returnType;
      }
    }
  }

  private emitExpression(expr: Expression, lines: string[], expected?: ValueType): EmittedValue {
    switch (expr.kind) {
      case "IntegerLiteral": {
        const type: ValueType = expected === "i64" ? "i64" : "i32";
        return { llvm: String(expr.value), type };
      }
      case "FloatLiteral": {
        const type: ValueType = expected === "f32" ? "f32" : "f64";
        return { llvm: formatFloat(expr.value, type), type };
      }
      case "BooleanLiteral":
        return { llvm: expr.value ? "true" : "false", type: "bool" };
      case "CharLiteral": {
        const code = expr.value.codePointAt(0) ?? 0;
        return { llvm: String(code), type: "char" };
      }
      case "StringLiteral": {
        const global = this.internString(expr.value);
        const tmp = this.nextTemp();
        lines.push(
          `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
        );
        return { llvm: tmp, type: "string" };
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (!local) {
          throw new Error(`Codegen: unknown variable '${expr.name}'`);
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ${toLlvmType(local.type)}, ptr ${local.ptr}`);
        return { llvm: tmp, type: local.type };
      }
      case "UnaryExpression":
        return this.emitUnary(expr, lines);
      case "BinaryExpression":
        return this.emitBinary(expr, lines);
      case "CallExpression":
        return this.emitUserCall(expr, lines, false);
    }
  }

  private emitUnary(expr: UnaryExpression, lines: string[]): EmittedValue {
    const operand = this.emitExpression(expr.operand, lines);
    const llvmType = toLlvmType(operand.type);
    const tmp = this.nextTemp();
    if (operand.type === "f32" || operand.type === "f64") {
      lines.push(`  ${tmp} = fneg ${llvmType} ${operand.llvm}`);
    } else {
      lines.push(`  ${tmp} = sub ${llvmType} 0, ${operand.llvm}`);
    }
    return { llvm: tmp, type: operand.type };
  }

  private emitBinary(expr: BinaryExpression, lines: string[]): EmittedValue {
    if (expr.operator === "+") {
      const leftType = this.inferExpressionType(expr.left);
      if (leftType === "string") {
        return this.emitStringConcat(expr, lines);
      }
    }

    const left = this.emitExpression(expr.left, lines);
    const right = this.emitExpression(expr.right, lines, left.type);
    const llvmType = toLlvmType(left.type);
    const tmp = this.nextTemp();
    const isFloat = left.type === "f32" || left.type === "f64";

    let opcode: string;
    switch (expr.operator) {
      case "+":
        opcode = isFloat ? "fadd" : "add";
        break;
      case "-":
        opcode = isFloat ? "fsub" : "sub";
        break;
      case "*":
        opcode = isFloat ? "fmul" : "mul";
        break;
      case "/":
        opcode = isFloat ? "fdiv" : "sdiv";
        break;
      case "%":
        opcode = isFloat ? "frem" : "srem";
        break;
    }

    lines.push(`  ${tmp} = ${opcode} ${llvmType} ${left.llvm}, ${right.llvm}`);
    return { llvm: tmp, type: left.type };
  }

  private emitStringConcat(expr: BinaryExpression, lines: string[]): EmittedValue {
    if (expr.left.kind === "StringLiteral" && expr.right.kind === "StringLiteral") {
      const folded = expr.left.value + expr.right.value;
      const global = this.internString(folded);
      const tmp = this.nextTemp();
      lines.push(
        `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      return { llvm: tmp, type: "string" };
    }

    this.needsStringRuntime = true;
    const left = this.emitExpression(expr.left, lines);
    const right = this.emitExpression(expr.right, lines);

    const leftLen = this.nextTemp();
    const rightLen = this.nextTemp();
    const total = this.nextTemp();
    const buf = this.nextTemp();

    lines.push(`  ${leftLen} = call i64 @strlen(ptr noundef ${left.llvm})`);
    lines.push(`  ${rightLen} = call i64 @strlen(ptr noundef ${right.llvm})`);
    lines.push(`  ${total} = add i64 ${leftLen}, ${rightLen}`);
    const totalPlus = this.nextTemp();
    lines.push(`  ${totalPlus} = add i64 ${total}, 1`);
    lines.push(`  ${buf} = call ptr @malloc(i64 noundef ${totalPlus})`);
    lines.push(`  call ptr @strcpy(ptr noundef ${buf}, ptr noundef ${left.llvm})`);
    lines.push(`  call ptr @strcat(ptr noundef ${buf}, ptr noundef ${right.llvm})`);

    return { llvm: buf, type: "string" };
  }

  private emitUserCall(
    call: CallExpression,
    lines: string[],
    asStatement: boolean,
  ): EmittedValue {
    const sig = this.functions.get(call.callee.name);
    if (!sig) {
      throw new Error(`Codegen: unknown function '${call.callee.name}'`);
    }

    const args: EmittedValue[] = [];
    for (let i = 0; i < call.args.length; i += 1) {
      args.push(this.emitExpression(call.args[i]!, lines, sig.params[i]));
    }

    const argList = args.map((a) => `${toLlvmType(a.type)} ${a.llvm}`).join(", ");
    const argSuffix = argList ? argList : "";

    if (sig.returnType === "void") {
      lines.push(`  call void @${sig.name}(${argSuffix})`);
      if (!asStatement) {
        throw new Error(`Codegen: void call '${sig.name}' used as value`);
      }
      return { llvm: "void", type: "i32" };
    }

    const tmp = this.nextTemp();
    const retTy = toLlvmType(sig.returnType);
    lines.push(`  ${tmp} = call ${retTy} @${sig.name}(${argSuffix})`);
    return { llvm: tmp, type: sig.returnType };
  }

  private emitPrintCall(call: CallExpression, lines: string[]): void {
    this.needsPrintf = true;

    const emittedArgs: EmittedValue[] = [];
    const formatParts: string[] = [];

    for (const arg of call.args) {
      const value = this.emitExpression(arg, lines);
      if (value.type === "bool") {
        const boolStr = this.emitBoolToString(value.llvm, lines);
        emittedArgs.push({ llvm: boolStr, type: "string" });
        formatParts.push("%s");
      } else {
        emittedArgs.push(value);
        formatParts.push(printfSpecifier(value.type));
      }
    }

    const format = `${formatParts.join(" ")}\n`;
    const formatGlobal = this.internString(format);
    const formatPtr = this.nextTemp();
    lines.push(
      `  ${formatPtr} = getelementptr inbounds [${formatGlobal.length} x i8], ptr @${formatGlobal.name}, i64 0, i64 0`,
    );

    const argList = emittedArgs
      .map((arg) => {
        if (arg.type === "f32") {
          const widened = this.nextTemp();
          lines.push(`  ${widened} = fpext float ${arg.llvm} to double`);
          return `double ${widened}`;
        }
        return `${printfArgType(arg.type)} ${arg.llvm}`;
      })
      .join(", ");

    lines.push(
      `  call i32 (ptr, ...) @printf(ptr noundef ${formatPtr}${argList ? `, ${argList}` : ""})`,
    );
  }

  private emitBoolToString(boolValue: string, lines: string[]): string {
    const trueGlobal = this.internString("true");
    const falseGlobal = this.internString("false");
    const truePtr = this.nextTemp();
    const falsePtr = this.nextTemp();
    const selected = this.nextTemp();

    lines.push(
      `  ${truePtr} = getelementptr inbounds [${trueGlobal.length} x i8], ptr @${trueGlobal.name}, i64 0, i64 0`,
    );
    lines.push(
      `  ${falsePtr} = getelementptr inbounds [${falseGlobal.length} x i8], ptr @${falseGlobal.name}, i64 0, i64 0`,
    );
    lines.push(`  ${selected} = select i1 ${boolValue}, ptr ${truePtr}, ptr ${falsePtr}`);
    return selected;
  }

  private nextTemp(): string {
    const name = `%t${this.tempCounter}`;
    this.tempCounter += 1;
    return name;
  }

  private internString(value: string): { name: string; length: number } {
    const existing = this.stringGlobals.get(value);
    if (existing) {
      return existing;
    }

    const name = `.str.${this.stringCounter}`;
    this.stringCounter += 1;
    const length = Buffer.byteLength(value, "utf8") + 1;
    const entry = { name, length };
    this.stringGlobals.set(value, entry);
    return entry;
  }

  private emitStringGlobals(): string[] {
    const lines: string[] = [];
    for (const [value, { name, length }] of this.stringGlobals) {
      const encoded = encodeLlvmString(value);
      lines.push(
        `@${name} = private unnamed_addr constant [${length} x i8] c"${encoded}\\00", align 1`,
      );
    }
    return lines;
  }
}

function toLlvmType(type: ValueType | "void"): string {
  switch (type) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "float";
    case "f64":
      return "double";
    case "bool":
      return "i1";
    case "char":
      return "i8";
    case "string":
      return "ptr";
    case "void":
      return "void";
  }
}

function printfSpecifier(type: ValueType): string {
  switch (type) {
    case "i32":
      return "%d";
    case "i64":
      return "%lld";
    case "f32":
    case "f64":
      return "%g";
    case "bool":
      return "%s";
    case "char":
      return "%c";
    case "string":
      return "%s";
  }
}

function printfArgType(type: ValueType): string {
  switch (type) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
    case "f64":
      return "double";
    case "bool":
      return "i1";
    case "char":
      return "i8";
    case "string":
      return "ptr";
  }
}

function formatFloat(value: number, _type: ValueType): string {
  if (Number.isInteger(value)) {
    return `${value}.0`;
  }
  return String(value);
}

/** Escape a UTF-8 string for an LLVM `c"..."` constant (without the trailing NUL). */
export function encodeLlvmString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c || byte < 0x20 || byte > 0x7e) {
      out += `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}
