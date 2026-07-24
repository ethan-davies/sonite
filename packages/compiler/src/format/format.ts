import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Program,
  Statement,
  TopLevelDeclaration,
} from "../ast/nodes.js";
import {
  DiagnosticCollector,
  type Diagnostic,
} from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { attachComments } from "./comments.js";
import type { FormatOptions } from "./options.js";
import { resolveFormatOptions } from "./options.js";
import {
  printProgram,
  printStatementNode,
  printTopLevelDecl,
} from "./printer.js";

export interface FormatResult {
  readonly code: string | null;
  readonly ast: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

export interface FormatSourceOptions extends Partial<FormatOptions> {
  readonly fileName?: string;
}

export interface FormatRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface FormatRangeEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

export interface FormatRangeResult {
  readonly edit: FormatRangeEdit | null;
  readonly ast: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly success: boolean;
}

/**
 * Parse source and pretty-print it.
 * Formats recovered ASTs even when parse errors are present; does not invent
 * missing tokens for incomplete constructs.
 */
export function formatSource(
  source: string,
  options: FormatSourceOptions = {},
): FormatResult {
  const diagnostics = new DiagnosticCollector();
  const fileName = options.fileName ?? "<source>";
  diagnostics.setFile(fileName);

  const formatOpts = resolveFormatOptions(options);
  const lexer = new Lexer(source, diagnostics);
  const { tokens, comments } = lexer.tokenizeWithComments();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();

  const attachments = attachComments(ast, comments);
  try {
    const code = printProgram(ast, formatOpts, attachments);
    return {
      code,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.error(`formatter failed: ${message}`, undefined, "E0100");
    return {
      code: null,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }
}

export function formatFile(
  filePath: string,
  options: Partial<FormatOptions> = {},
): FormatResult {
  const absolute = resolve(filePath);
  const source = readFileSync(absolute, "utf8");
  return formatSource(source, { ...options, fileName: absolute });
}

/**
 * Format the smallest enclosing statement or top-level declaration covering
 * `[startOffset, endOffset)`, returning a single edit for that expanded span.
 */
export function formatRange(
  source: string,
  range: FormatRange,
  options: FormatSourceOptions = {},
): FormatRangeResult {
  const diagnostics = new DiagnosticCollector();
  const fileName = options.fileName ?? "<source>";
  diagnostics.setFile(fileName);

  const formatOpts = resolveFormatOptions(options);
  const lexer = new Lexer(source, diagnostics);
  const { tokens, comments } = lexer.tokenizeWithComments();
  const parser = new Parser(tokens, diagnostics);
  const ast = parser.parse();
  const attachments = attachComments(ast, comments);

  const target = findEnclosingNode(ast, range.startOffset, range.endOffset);
  if (!target) {
    return {
      edit: null,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: true,
    };
  }

  try {
    let newText: string;
    let startOffset: number;
    let endOffset: number;

    if (target.kind === "statement") {
      const indent = indentLevelAt(
        source,
        target.node.span.start.offset,
        formatOpts,
      );
      newText = printStatementNode(
        target.node,
        formatOpts,
        indent,
        attachments,
      );
      startOffset = target.node.span.start.offset;
      // Statements are printed with leading indent; span starts at the keyword,
      // so strip leading whitespace from the original start back to line indent.
      const lineStart = source.lastIndexOf("\n", startOffset - 1) + 1;
      startOffset = lineStart;
      endOffset = extendEndThroughNewline(source, target.node.span.end.offset);
      if (!newText.endsWith("\n")) {
        newText = `${newText}\n`;
      }
    } else {
      newText = printTopLevelDecl(target.node, formatOpts, 0, attachments);
      if (!newText.endsWith("\n")) {
        newText = `${newText}\n`;
      }
      startOffset = target.node.span.start.offset;
      endOffset = extendEndThroughNewline(source, target.node.span.end.offset);
    }

    const original = source.slice(startOffset, endOffset);
    if (original === newText) {
      return {
        edit: null,
        ast,
        diagnostics: diagnostics.diagnostics,
        success: true,
      };
    }

    return {
      edit: { startOffset, endOffset, newText },
      ast,
      diagnostics: diagnostics.diagnostics,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.error(`formatter failed: ${message}`, undefined, "E0100");
    return {
      edit: null,
      ast,
      diagnostics: diagnostics.diagnostics,
      success: false,
    };
  }
}

type Enclosing =
  | { kind: "statement"; node: Statement }
  | { kind: "declaration"; node: TopLevelDeclaration };

function findEnclosingNode(
  ast: Program,
  start: number,
  end: number,
): Enclosing | null {
  let bestStmt: Statement | null = null;
  let bestStmtSize = Infinity;
  let bestDecl: TopLevelDeclaration | null = null;
  let bestDeclSize = Infinity;

  const covers = (spanStart: number, spanEnd: number): boolean =>
    spanStart <= start && end <= spanEnd;

  const considerStmt = (stmt: Statement): void => {
    const size = stmt.span.end.offset - stmt.span.start.offset;
    if (
      covers(stmt.span.start.offset, stmt.span.end.offset) &&
      size < bestStmtSize
    ) {
      bestStmt = stmt;
      bestStmtSize = size;
    }
    for (const child of nestedStatements(stmt)) {
      considerStmt(child);
    }
  };

  for (const decl of ast.body) {
    const size = decl.span.end.offset - decl.span.start.offset;
    if (
      covers(decl.span.start.offset, decl.span.end.offset) &&
      size < bestDeclSize
    ) {
      bestDecl = decl;
      bestDeclSize = size;
    }
    for (const stmt of declarationStatements(decl)) {
      considerStmt(stmt);
    }
  }

  if (bestStmt) {
    return { kind: "statement", node: bestStmt };
  }
  if (bestDecl) {
    return { kind: "declaration", node: bestDecl };
  }
  return null;
}

function declarationStatements(decl: TopLevelDeclaration): Statement[] {
  if (decl.kind === "FunctionDeclaration" && decl.body) {
    return [...decl.body];
  }
  if (decl.kind === "StructDeclaration") {
    return decl.methods.flatMap((m) => m.body);
  }
  if (decl.kind === "ClassDeclaration") {
    const out: Statement[] = [];
    for (const m of decl.members) {
      if (m.kind === "ClassMethod" && m.body) {
        out.push(...m.body);
      } else if (m.kind === "ConstructorDeclaration") {
        out.push(...m.body);
      }
    }
    return out;
  }
  return [];
}

function nestedStatements(stmt: Statement): Statement[] {
  switch (stmt.kind) {
    case "IfStatement": {
      const parts = [...stmt.consequent];
      if (Array.isArray(stmt.alternate)) {
        parts.push(...stmt.alternate);
      } else if (stmt.alternate) {
        parts.push(stmt.alternate);
      }
      return parts;
    }
    case "WhileStatement":
    case "ForStatement":
    case "ForInStatement":
      return [...stmt.body];
    case "SwitchStatement":
      return stmt.cases.flatMap((c) => c.body);
    case "TryStatement": {
      const parts = [...stmt.tryBlock];
      if (stmt.catchClause) {
        parts.push(...stmt.catchClause.body);
      }
      if (stmt.finallyBlock) {
        parts.push(...stmt.finallyBlock);
      }
      return parts;
    }
    default:
      return [];
  }
}

function indentLevelAt(
  source: string,
  offset: number,
  options: FormatOptions,
): number {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const prefix = source.slice(lineStart, offset);
  if (options.useTabs) {
    return prefix.replace(/[^\t]/g, "").length;
  }
  const spaces = prefix.match(/^ */)?.[0].length ?? 0;
  return Math.floor(spaces / Math.max(1, options.indentWidth));
}

function extendEndThroughNewline(source: string, end: number): number {
  let i = end;
  if (source[i] === "\r") {
    i += 1;
  }
  if (source[i] === "\n") {
    i += 1;
  }
  return i;
}
