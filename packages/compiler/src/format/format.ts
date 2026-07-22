import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Program } from "../ast/nodes.js";
import {
  DiagnosticCollector,
  type Diagnostic,
} from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { printProgram } from "./printer.js";

export interface FormatResult {
  readonly code: string | null;
  readonly ast: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

/**
 * Parse source and pretty-print it. Does not rewrite when parse errors occur.
 * Comments are not preserved in v1.
 */
export function formatSource(
  source: string,
  options: { readonly fileName?: string } = {},
): FormatResult {
  const diagnostics = new DiagnosticCollector();
  const fileName = options.fileName ?? "<source>";
  diagnostics.setFile(fileName);

  const lexer = new Lexer(source, diagnostics);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  if (diagnostics.hasErrors) {
    return {
      code: null,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }

  return {
    code: printProgram(ast),
    ast,
    diagnostics: diagnostics.diagnostics,
    success: true,
  };
}

export function formatFile(filePath: string): FormatResult {
  const absolute = resolve(filePath);
  const source = readFileSync(absolute, "utf8");
  return formatSource(source, { fileName: absolute });
}
