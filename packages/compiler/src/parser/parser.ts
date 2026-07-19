import type {
  AssignmentStatement,
  BinaryExpression,
  BooleanLiteral,
  CallExpression,
  CharLiteral,
  Expression,
  ExpressionStatement,
  FloatLiteral,
  FunctionDeclaration,
  Identifier,
  IntegerLiteral,
  PrimitiveTypeName,
  Program,
  Statement,
  StringLiteral,
  TypeAnnotation,
  VariableDeclaration,
} from "../ast/nodes.js";
import type { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { TokenKind, type Token } from "../lexer/tokens.js";

const PRIMITIVE_TYPES = new Set<string>([
  "i32",
  "i64",
  "f32",
  "f64",
  "bool",
  "string",
  "char",
  "void",
]);

/**
 * Recursive-descent parser:
 *
 *   program      = functionDecl EOF
 *   functionDecl = "function" Ident "(" ")" ":" type "{" statement* "}"
 *   statement    = varDecl | assignment | exprStmt
 *   varDecl      = ("let"|"const") Ident (":" type)? "=" expression ";"
 *   assignment   = Ident "=" expression ";"
 *   exprStmt     = callExpr ";"
 *   expression   = primary ("+" primary)*
 *   primary      = literal | Ident | callExpr
 *   callExpr     = Ident "(" (expression ("," expression)*)? ")"
 *   type         = Ident
 */
export class Parser {
  private readonly tokens: Token[];
  private readonly diagnostics: DiagnosticCollector;
  private current = 0;

  constructor(tokens: Token[], diagnostics: DiagnosticCollector) {
    this.tokens = tokens;
    this.diagnostics = diagnostics;
  }

  parse(): Program {
    const start = this.peek().span.start;
    const functions: FunctionDeclaration[] = [];

    if (!this.check(TokenKind.Eof)) {
      const fn = this.parseFunctionDeclaration();
      if (fn) {
        functions.push(fn);
      }

      while (!this.isAtEnd()) {
        this.diagnostics.error(
          `Unexpected token '${this.peek().lexeme}'`,
          this.peek().span,
          "E0101",
        );
        this.advance();
      }
    }

    const eof = this.peek();
    return {
      kind: "Program",
      body: functions,
      span: { start, end: eof.span.end },
    };
  }

  private parseFunctionDeclaration(): FunctionDeclaration | null {
    const start = this.peek().span.start;

    if (!this.expect(TokenKind.Function, "Expected 'function'")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const nameToken = this.expect(TokenKind.Identifier, "Expected function name");
    if (!nameToken) {
      this.synchronizeToTopLevel();
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.LParen, "Expected '(' after function name")) {
      this.synchronizeToTopLevel();
      return null;
    }
    if (!this.expect(TokenKind.RParen, "Expected ')' after parameter list")) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.Colon, "Expected ':' before return type")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const returnType = this.parseType();
    if (!returnType) {
      this.synchronizeToTopLevel();
      return null;
    }

    if (!this.expect(TokenKind.LBrace, "Expected '{' before function body")) {
      this.synchronizeToTopLevel();
      return null;
    }

    const body: Statement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (stmt) {
        body.push(stmt);
      } else {
        this.synchronizeStatement();
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}' after function body");
    const end = rbrace?.span.end ?? this.peek().span.end;

    return {
      kind: "FunctionDeclaration",
      name,
      returnType,
      body,
      span: { start, end },
    };
  }

  private parseStatement(): Statement | null {
    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      return this.parseVariableDeclaration();
    }

    if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.Equal)) {
      return this.parseAssignment();
    }

    return this.parseExpressionStatement();
  }

  private parseVariableDeclaration(): VariableDeclaration | null {
    const start = this.peek().span.start;
    const mutabilityToken = this.advance();
    const mutability = mutabilityToken.kind === TokenKind.Const ? "const" : "let";

    const nameToken = this.expect(TokenKind.Identifier, "Expected variable name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    let typeAnnotation: TypeAnnotation | null = null;
    if (this.check(TokenKind.Colon)) {
      this.advance();
      typeAnnotation = this.parseType();
      if (!typeAnnotation) {
        return null;
      }
    }

    if (!this.expect(TokenKind.Equal, "Expected '=' after variable name")) {
      return null;
    }

    const initializer = this.parseExpression();
    if (!initializer) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after variable declaration");
    const end = semicolon?.span.end ?? initializer.span.end;

    return {
      kind: "VariableDeclaration",
      mutability,
      name,
      typeAnnotation,
      initializer,
      span: { start, end },
    };
  }

  private parseAssignment(): AssignmentStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Equal, "Expected '=' in assignment")) {
      return null;
    }

    const value = this.parseExpression();
    if (!value) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after assignment");
    const end = semicolon?.span.end ?? value.span.end;

    return {
      kind: "AssignmentStatement",
      name,
      value,
      span: { start, end },
    };
  }

  private parseExpressionStatement(): ExpressionStatement | null {
    const start = this.peek().span.start;

    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.error("Expected a statement", this.peek().span, "E0102");
      return null;
    }

    if (!this.checkNext(TokenKind.LParen)) {
      this.diagnostics.error(
        `Expected a call statement; found '${this.peek().lexeme}'`,
        this.peek().span,
        "E0102",
      );
      return null;
    }

    const expression = this.parseCallExpression();
    if (!expression) {
      return null;
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after expression");
    const end = semicolon?.span.end ?? expression.span.end;

    return {
      kind: "ExpressionStatement",
      expression,
      span: { start, end },
    };
  }

  private parseExpression(): Expression | null {
    let left = this.parsePrimary();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.Plus)) {
      this.advance();
      const right = this.parsePrimary();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: "+",
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parsePrimary(): Expression | null {
    if (this.check(TokenKind.Identifier) && this.checkNext(TokenKind.LParen)) {
      return this.parseCallExpression();
    }

    if (this.check(TokenKind.Identifier)) {
      const token = this.advance();
      return {
        kind: "Identifier",
        name: token.lexeme,
        span: token.span,
      };
    }

    if (this.check(TokenKind.String)) {
      const token = this.advance();
      const literal: StringLiteral = {
        kind: "StringLiteral",
        value: token.value ?? "",
        raw: token.lexeme,
        span: token.span,
      };
      return literal;
    }

    if (this.check(TokenKind.Integer)) {
      const token = this.advance();
      const literal: IntegerLiteral = {
        kind: "IntegerLiteral",
        value: Number.parseInt(token.lexeme, 10),
        raw: token.lexeme,
        span: token.span,
      };
      return literal;
    }

    if (this.check(TokenKind.Float)) {
      const token = this.advance();
      const literal: FloatLiteral = {
        kind: "FloatLiteral",
        value: Number.parseFloat(token.lexeme),
        raw: token.lexeme,
        span: token.span,
      };
      return literal;
    }

    if (this.check(TokenKind.True) || this.check(TokenKind.False)) {
      const token = this.advance();
      const literal: BooleanLiteral = {
        kind: "BooleanLiteral",
        value: token.kind === TokenKind.True,
        span: token.span,
      };
      return literal;
    }

    if (this.check(TokenKind.Char)) {
      const token = this.advance();
      const literal: CharLiteral = {
        kind: "CharLiteral",
        value: token.value ?? "",
        raw: token.lexeme,
        span: token.span,
      };
      return literal;
    }

    this.diagnostics.error(`Expected an expression, found '${this.peek().lexeme}'`, this.peek().span, "E0103");
    return null;
  }

  private parseCallExpression(): CallExpression | null {
    const start = this.peek().span.start;
    const calleeToken = this.expect(TokenKind.Identifier, "Expected function name");
    if (!calleeToken) {
      return null;
    }

    const callee: Identifier = {
      kind: "Identifier",
      name: calleeToken.lexeme,
      span: calleeToken.span,
    };

    if (!this.expect(TokenKind.LParen, "Expected '(' after function name")) {
      return null;
    }

    const args: Expression[] = [];
    if (!this.check(TokenKind.RParen)) {
      const first = this.parseExpression();
      if (!first) {
        return null;
      }
      args.push(first);

      while (this.check(TokenKind.Comma)) {
        this.advance();
        const arg = this.parseExpression();
        if (!arg) {
          return null;
        }
        args.push(arg);
      }
    }

    const rparen = this.expect(TokenKind.RParen, "Expected ')' after arguments");
    const end = rparen?.span.end ?? this.peek().span.end;

    return {
      kind: "CallExpression",
      callee,
      args,
      span: { start, end },
    };
  }

  private parseType(): TypeAnnotation | null {
    const token = this.expect(TokenKind.Identifier, "Expected a type name");
    if (!token) {
      return null;
    }

    if (!PRIMITIVE_TYPES.has(token.lexeme)) {
      this.diagnostics.error(
        `Unknown type '${token.lexeme}'`,
        token.span,
        "E0104",
      );
      return null;
    }

    return {
      kind: "TypeAnnotation",
      name: token.lexeme as PrimitiveTypeName,
      span: token.span,
    };
  }

  private expect(kind: TokenKind, message: string): Token | null {
    if (this.check(kind)) {
      return this.advance();
    }
    this.diagnostics.error(message, this.peek().span, "E0103");
    return null;
  }

  private synchronizeStatement(): void {
    while (!this.isAtEnd()) {
      if (this.check(TokenKind.Semicolon)) {
        this.advance();
        return;
      }
      if (this.check(TokenKind.RBrace)) {
        return;
      }
      this.advance();
    }
  }

  private synchronizeToTopLevel(): void {
    while (!this.isAtEnd()) {
      this.advance();
    }
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkNext(kind: TokenKind): boolean {
    const next = this.tokens[this.current + 1];
    return next?.kind === kind;
  }

  private peek(): Token {
    return this.tokens[this.current] ?? this.tokens[this.tokens.length - 1]!;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === TokenKind.Eof;
  }

  private advance(): Token {
    const token = this.peek();
    if (!this.isAtEnd()) {
      this.current += 1;
    }
    return token;
  }
}
