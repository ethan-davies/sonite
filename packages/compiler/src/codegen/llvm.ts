import type {
  AssignmentStatement,
  BinaryExpression,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Program,
  Statement,
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

/**
 * Lowers a validated, type-checked AST to LLVM IR text.
 */
export class LlvmCodegen {
  private stringCounter = 0;
  private tempCounter = 0;
  private readonly stringGlobals = new Map<string, { name: string; length: number }>();
  private readonly locals = new Map<string, LocalBinding>();
  private needsPrintf = false;
  private needsStringRuntime = false;
  private readonly lines: string[] = [];

  emit(program: Program): string {
    this.stringCounter = 0;
    this.tempCounter = 0;
    this.stringGlobals.clear();
    this.locals.clear();
    this.needsPrintf = false;
    this.needsStringRuntime = false;
    this.lines.length = 0;

    const fn = program.body[0];
    if (!fn) {
      throw new Error("LlvmCodegen.emit called without a function");
    }

    this.emitMainBody(fn);

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
      "define i32 @main() {",
      "entry:",
      ...this.lines,
      "  ret i32 0",
      "}",
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private emitMainBody(fn: FunctionDeclaration): void {
    for (const stmt of fn.body) {
      this.emitStatement(stmt);
    }
  }

  private emitStatement(stmt: Statement): void {
    switch (stmt.kind) {
      case "VariableDeclaration":
        this.emitVariableDeclaration(stmt);
        return;
      case "AssignmentStatement":
        this.emitAssignment(stmt);
        return;
      case "ExpressionStatement":
        if (stmt.expression.kind === "CallExpression") {
          this.emitPrintCall(stmt.expression);
        }
        return;
    }
  }

  private emitVariableDeclaration(stmt: VariableDeclaration): void {
    const type = this.resolveDeclType(stmt);
    const llvmType = toLlvmType(type);
    const ptr = `%v.${stmt.name.name}`;
    this.lines.push(`  ${ptr} = alloca ${llvmType}`);
    this.locals.set(stmt.name.name, { ptr, type });

    const init = this.emitExpression(stmt.initializer, type);
    this.lines.push(`  store ${llvmType} ${init.llvm}, ptr ${ptr}`);
  }

  private emitAssignment(stmt: AssignmentStatement): void {
    const local = this.locals.get(stmt.name.name);
    if (!local) {
      throw new Error(`Codegen: unknown variable '${stmt.name.name}'`);
    }
    const value = this.emitExpression(stmt.value, local.type);
    this.lines.push(`  store ${toLlvmType(local.type)} ${value.llvm}, ptr ${local.ptr}`);
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
      case "BinaryExpression":
        return "string";
      case "CallExpression":
        throw new Error("Codegen: unexpected call in type inference");
    }
  }

  private emitExpression(expr: Expression, expected?: ValueType): EmittedValue {
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
        const tmp = this.nextTemp("str");
        this.lines.push(
          `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
        );
        return { llvm: tmp, type: "string" };
      }
      case "Identifier": {
        const local = this.locals.get(expr.name);
        if (!local) {
          throw new Error(`Codegen: unknown variable '${expr.name}'`);
        }
        const tmp = this.nextTemp("load");
        this.lines.push(`  ${tmp} = load ${toLlvmType(local.type)}, ptr ${local.ptr}`);
        return { llvm: tmp, type: local.type };
      }
      case "BinaryExpression":
        return this.emitStringConcat(expr);
      case "CallExpression":
        throw new Error("Codegen: call expressions are not values");
    }
  }

  private emitStringConcat(expr: BinaryExpression): EmittedValue {
    if (expr.left.kind === "StringLiteral" && expr.right.kind === "StringLiteral") {
      const folded = expr.left.value + expr.right.value;
      const global = this.internString(folded);
      const tmp = this.nextTemp("str");
      this.lines.push(
        `  ${tmp} = getelementptr inbounds [${global.length} x i8], ptr @${global.name}, i64 0, i64 0`,
      );
      return { llvm: tmp, type: "string" };
    }

    this.needsStringRuntime = true;
    const left = this.emitExpression(expr.left);
    const right = this.emitExpression(expr.right);

    const leftLen = this.nextTemp("len");
    const rightLen = this.nextTemp("len");
    const total = this.nextTemp("total");
    const buf = this.nextTemp("buf");

    this.lines.push(`  ${leftLen} = call i64 @strlen(ptr noundef ${left.llvm})`);
    this.lines.push(`  ${rightLen} = call i64 @strlen(ptr noundef ${right.llvm})`);
    this.lines.push(`  ${total} = add i64 ${leftLen}, ${rightLen}`);
    const totalPlus = this.nextTemp("total");
    this.lines.push(`  ${totalPlus} = add i64 ${total}, 1`);
    this.lines.push(`  ${buf} = call ptr @malloc(i64 noundef ${totalPlus})`);
    this.lines.push(`  call ptr @strcpy(ptr noundef ${buf}, ptr noundef ${left.llvm})`);
    this.lines.push(`  call ptr @strcat(ptr noundef ${buf}, ptr noundef ${right.llvm})`);

    return { llvm: buf, type: "string" };
  }

  private emitPrintCall(call: CallExpression): void {
    if (call.callee.name !== "print") {
      throw new Error(`Codegen: unsupported call '${call.callee.name}'`);
    }
    this.needsPrintf = true;

    const emittedArgs: EmittedValue[] = [];
    const formatParts: string[] = [];

    for (const arg of call.args) {
      const value = this.emitExpression(arg);
      if (value.type === "bool") {
        const boolStr = this.emitBoolToString(value.llvm);
        emittedArgs.push({ llvm: boolStr, type: "string" });
        formatParts.push("%s");
      } else {
        emittedArgs.push(value);
        formatParts.push(printfSpecifier(value.type));
      }
    }

    const format = `${formatParts.join(" ")}\n`;
    const formatGlobal = this.internString(format);
    const formatPtr = this.nextTemp("fmt");
    this.lines.push(
      `  ${formatPtr} = getelementptr inbounds [${formatGlobal.length} x i8], ptr @${formatGlobal.name}, i64 0, i64 0`,
    );

    const argList = emittedArgs
      .map((arg) => {
        if (arg.type === "f32") {
          const widened = this.nextTemp("fpext");
          this.lines.push(`  ${widened} = fpext float ${arg.llvm} to double`);
          return `double ${widened}`;
        }
        return `${printfArgType(arg.type)} ${arg.llvm}`;
      })
      .join(", ");

    this.lines.push(
      `  call i32 (ptr, ...) @printf(ptr noundef ${formatPtr}${argList ? `, ${argList}` : ""})`,
    );
  }

  private emitBoolToString(boolValue: string): string {
    const trueGlobal = this.internString("true");
    const falseGlobal = this.internString("false");
    const truePtr = this.nextTemp("true");
    const falsePtr = this.nextTemp("false");
    const selected = this.nextTemp("boolstr");

    this.lines.push(
      `  ${truePtr} = getelementptr inbounds [${trueGlobal.length} x i8], ptr @${trueGlobal.name}, i64 0, i64 0`,
    );
    this.lines.push(
      `  ${falsePtr} = getelementptr inbounds [${falseGlobal.length} x i8], ptr @${falseGlobal.name}, i64 0, i64 0`,
    );
    this.lines.push(`  ${selected} = select i1 ${boolValue}, ptr ${truePtr}, ptr ${falsePtr}`);
    return selected;
  }

  private nextTemp(_prefix: string): string {
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

function toLlvmType(type: ValueType): string {
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

function formatFloat(value: number, type: ValueType): string {
  // LLVM float/double constants need a decimal representation.
  if (Number.isInteger(value)) {
    return type === "f32" ? `${value}.0` : `${value}.0`;
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
