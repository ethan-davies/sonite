export { compile, compileFile, formatDiagnostics } from "./compiler.js";
export type { CompileFileOptions, CompileOptions, CompileResult } from "./compiler.js";

export { Lexer, TokenKind } from "./lexer/index.js";
export type { Token } from "./lexer/index.js";

export { Parser } from "./parser/index.js";

export { LlvmCodegen, encodeLlvmString } from "./codegen/index.js";

export { DiagnosticCollector } from "./diagnostics/index.js";
export type { Diagnostic, SourceLocation, SourceSpan } from "./diagnostics/index.js";

export {
  mangleSymbol,
  moduleIdFromPath,
  resolveImportSpecifier,
  resolveModules,
} from "./modules/index.js";
export type {
  ModuleImportBinding,
  ReadFileFn,
  ResolveResult,
  ResolvedModule,
} from "./modules/index.js";

export type {
  AstNode,
  Expression,
  Program,
  Statement,
} from "./ast/index.js";
