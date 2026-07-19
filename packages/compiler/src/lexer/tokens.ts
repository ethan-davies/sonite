import type { SourceSpan } from "../diagnostics/diagnostic.js";

export enum TokenKind {
  Identifier = "Identifier",
  String = "String",
  Char = "Char",
  Integer = "Integer",
  Float = "Float",

  Function = "function",
  Let = "let",
  Const = "const",
  Return = "return",
  True = "true",
  False = "false",
  If = "if",
  Else = "else",
  ElseIf = "elseif",

  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  Semicolon = ";",
  Colon = ":",
  Comma = ",",
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Percent = "%",
  Equal = "=",
  EqualEqual = "==",
  Bang = "!",
  BangEqual = "!=",
  Less = "<",
  LessEqual = "<=",
  Greater = ">",
  GreaterEqual = ">=",
  AmpAmp = "&&",
  PipePipe = "||",

  Eof = "Eof",
  Invalid = "Invalid",
}

export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  /** Decoded value for string/char literals; otherwise undefined. */
  readonly value?: string;
  readonly span: SourceSpan;
}

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["function", TokenKind.Function],
  ["let", TokenKind.Let],
  ["const", TokenKind.Const],
  ["return", TokenKind.Return],
  ["true", TokenKind.True],
  ["false", TokenKind.False],
  ["if", TokenKind.If],
  ["else", TokenKind.Else],
  ["elseif", TokenKind.ElseIf],
]);
