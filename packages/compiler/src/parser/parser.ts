import type {
  AssignmentStatement,
  BinaryExpression,
  BinaryOperator,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  CharLiteral,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  FloatLiteral,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  IntegerLiteral,
  Parameter,
  PrimitiveTypeName,
  Program,
  ReturnStatement,
  Statement,
  StringLiteral,
  TypeAnnotation,
  UnaryExpression,
  UpdateStatement,
  VariableDeclaration,
  WhileStatement,
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

const ASSIGNMENT_OPS = new Set<TokenKind>([
  TokenKind.Equal,
  TokenKind.PlusEqual,
  TokenKind.MinusEqual,
]);

const UPDATE_OPS = new Set<TokenKind>([TokenKind.PlusPlus, TokenKind.MinusMinus]);

/**
 * Recursive-descent parser:
 *
 *   program      = functionDecl*
 *   functionDecl = "function" Ident "(" params? ")" ":" type block
 *   params       = param ("," param)*
 *   param        = Ident ":" type
 *   statement    = varDecl | assignment | updateStmt | returnStmt
 *                | ifStmt | whileStmt | forStmt | breakStmt | continueStmt | exprStmt
 *   varDecl      = ("let"|"const") Ident (":" type)? "=" expression ";"
 *   assignment   = Ident ("=" | "+=" | "-=") expression ";"
 *   updateStmt   = Ident ("++" | "--") ";"
 *   returnStmt   = "return" expression? ";"
 *   ifStmt       = "if" "(" expression ")" block
 *                  ("elseif" "(" expression ")" block)*
 *                  ("else" block)?
 *   whileStmt    = "while" "(" expression ")" block
 *   forStmt      = "for" "(" forInit condition? ";" forUpdate? ")" block
 *   forInit      = varDecl | assignment | ";"
 *   forUpdate    = updateStmtNoSemi | assignmentNoSemi
 *   breakStmt    = "break" ";"
 *   continueStmt = "continue" ";"
 *   block        = "{" statement* "}"
 *   exprStmt     = callExpr ";"
 *   expression   = or
 *   or           = and ("||" and)*
 *   and          = equality ("&&" equality)*
 *   equality     = relational (("==" | "!=") relational)*
 *   relational   = additive (("<" | "<=" | ">" | ">=") additive)*
 *   additive     = multiplicative (("+" | "-") multiplicative)*
 *   multiplicative = unary (("*" | "/" | "%") unary)*
 *   unary        = ("-" | "!") unary | primary
 *   primary      = "(" expression ")" | literal | Ident | callExpr
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

    while (!this.check(TokenKind.Eof)) {
      const fn = this.parseFunctionDeclaration();
      if (fn) {
        functions.push(fn);
      } else {
        break;
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

    const params = this.parseParameterList();
    if (params === null) {
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

    const body = this.parseBlock();
    if (!body) {
      this.synchronizeToTopLevel();
      return null;
    }

    return {
      kind: "FunctionDeclaration",
      name,
      params,
      returnType,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseParameterList(): Parameter[] | null {
    const params: Parameter[] = [];

    if (this.check(TokenKind.RParen)) {
      return params;
    }

    const first = this.parseParameter();
    if (!first) {
      return null;
    }
    params.push(first);

    while (this.check(TokenKind.Comma)) {
      this.advance();
      const param = this.parseParameter();
      if (!param) {
        return null;
      }
      params.push(param);
    }

    return params;
  }

  private parseParameter(): Parameter | null {
    const nameToken = this.expect(TokenKind.Identifier, "Expected parameter name");
    if (!nameToken) {
      return null;
    }

    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    if (!this.expect(TokenKind.Colon, "Expected ':' after parameter name")) {
      return null;
    }

    const typeAnnotation = this.parseType();
    if (!typeAnnotation) {
      return null;
    }

    return {
      kind: "Parameter",
      name,
      typeAnnotation,
      span: { start: name.span.start, end: typeAnnotation.span.end },
    };
  }

  private parseStatement(): Statement | null {
    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      return this.parseVariableDeclaration();
    }

    if (this.check(TokenKind.Return)) {
      return this.parseReturnStatement();
    }

    if (this.check(TokenKind.If)) {
      return this.parseIfStatement();
    }

    if (this.check(TokenKind.While)) {
      return this.parseWhileStatement();
    }

    if (this.check(TokenKind.For)) {
      return this.parseForStatement();
    }

    if (this.check(TokenKind.Break)) {
      return this.parseBreakStatement();
    }

    if (this.check(TokenKind.Continue)) {
      return this.parseContinueStatement();
    }

    if (this.check(TokenKind.Identifier)) {
      const next = this.tokens[this.current + 1];
      if (next && UPDATE_OPS.has(next.kind)) {
        return this.parseUpdateStatement(true);
      }
      if (next && ASSIGNMENT_OPS.has(next.kind)) {
        return this.parseAssignment(true);
      }
    }

    return this.parseExpressionStatement();
  }

  private parseBlock(): { statements: Statement[]; end: { line: number; column: number; offset: number } } | null {
    if (!this.expect(TokenKind.LBrace, "Expected '{'")) {
      return null;
    }

    const statements: Statement[] = [];
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      } else {
        this.synchronizeStatement();
      }
    }

    const rbrace = this.expect(TokenKind.RBrace, "Expected '}'");
    const end = rbrace?.span.end ?? this.peek().span.end;
    return { statements, end };
  }

  private parseIfStatement(): IfStatement | null {
    const start = this.peek().span.start;
    this.advance(); // if

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'if'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after if condition")) {
      return null;
    }

    const consequentBlock = this.parseBlock();
    if (!consequentBlock) {
      return null;
    }

    let alternate: IfStatement | Statement[] | null = null;
    let end = consequentBlock.end;

    if (this.check(TokenKind.ElseIf)) {
      const elseif = this.parseElseIfChain();
      if (!elseif) {
        return null;
      }
      alternate = elseif;
      end = elseif.span.end;
    } else if (this.check(TokenKind.Else)) {
      this.advance();
      const elseBlock = this.parseBlock();
      if (!elseBlock) {
        return null;
      }
      alternate = elseBlock.statements;
      end = elseBlock.end;
    }

    return {
      kind: "IfStatement",
      condition,
      consequent: consequentBlock.statements,
      alternate,
      span: { start, end },
    };
  }

  private parseWhileStatement(): WhileStatement | null {
    const start = this.peek().span.start;
    this.advance(); // while

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'while'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after while condition")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "WhileStatement",
      condition,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  private parseForStatement(): ForStatement | null {
    const start = this.peek().span.start;
    this.advance(); // for

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'for'")) {
      return null;
    }

    const initializer = this.parseForInitializer();
    if (initializer === undefined) {
      return null;
    }

    let condition: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      condition = this.parseExpression();
      if (!condition) {
        return null;
      }
    }
    if (!this.expect(TokenKind.Semicolon, "Expected ';' after for condition")) {
      return null;
    }

    let update: UpdateStatement | AssignmentStatement | null = null;
    if (!this.check(TokenKind.RParen)) {
      update = this.parseForUpdate();
      if (!update) {
        return null;
      }
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after for clauses")) {
      return null;
    }

    const body = this.parseBlock();
    if (!body) {
      return null;
    }

    return {
      kind: "ForStatement",
      initializer,
      condition,
      update,
      body: body.statements,
      span: { start, end: body.end },
    };
  }

  /** Returns null for empty init, undefined on parse failure. */
  private parseForInitializer(): VariableDeclaration | AssignmentStatement | null | undefined {
    if (this.check(TokenKind.Semicolon)) {
      this.advance();
      return null;
    }

    if (this.check(TokenKind.Let) || this.check(TokenKind.Const)) {
      return this.parseVariableDeclaration();
    }

    if (this.check(TokenKind.Identifier)) {
      const next = this.tokens[this.current + 1];
      if (next && ASSIGNMENT_OPS.has(next.kind)) {
        return this.parseAssignment(true);
      }
    }

    this.diagnostics.error("Expected for-loop initializer", this.peek().span, "E0102");
    return undefined;
  }

  private parseForUpdate(): UpdateStatement | AssignmentStatement | null {
    if (!this.check(TokenKind.Identifier)) {
      this.diagnostics.error("Expected for-loop update", this.peek().span, "E0102");
      return null;
    }

    const next = this.tokens[this.current + 1];
    if (next && UPDATE_OPS.has(next.kind)) {
      return this.parseUpdateStatement(false);
    }
    if (next && ASSIGNMENT_OPS.has(next.kind)) {
      return this.parseAssignment(false);
    }

    this.diagnostics.error("Expected for-loop update", this.peek().span, "E0102");
    return null;
  }

  private parseBreakStatement(): BreakStatement | null {
    const start = this.peek().span.start;
    this.advance(); // break
    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after 'break'");
    const end = semicolon?.span.end ?? this.peek().span.end;
    return {
      kind: "BreakStatement",
      span: { start, end },
    };
  }

  private parseContinueStatement(): ContinueStatement | null {
    const start = this.peek().span.start;
    this.advance(); // continue
    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after 'continue'");
    const end = semicolon?.span.end ?? this.peek().span.end;
    return {
      kind: "ContinueStatement",
      span: { start, end },
    };
  }

  /** Parse `elseif (cond) { ... }` as an IfStatement, chaining further elseif/else. */
  private parseElseIfChain(): IfStatement | null {
    const start = this.peek().span.start;
    this.advance(); // elseif

    if (!this.expect(TokenKind.LParen, "Expected '(' after 'elseif'")) {
      return null;
    }

    const condition = this.parseExpression();
    if (!condition) {
      return null;
    }

    if (!this.expect(TokenKind.RParen, "Expected ')' after elseif condition")) {
      return null;
    }

    const consequentBlock = this.parseBlock();
    if (!consequentBlock) {
      return null;
    }

    let alternate: IfStatement | Statement[] | null = null;
    let end = consequentBlock.end;

    if (this.check(TokenKind.ElseIf)) {
      const nested = this.parseElseIfChain();
      if (!nested) {
        return null;
      }
      alternate = nested;
      end = nested.span.end;
    } else if (this.check(TokenKind.Else)) {
      this.advance();
      const elseBlock = this.parseBlock();
      if (!elseBlock) {
        return null;
      }
      alternate = elseBlock.statements;
      end = elseBlock.end;
    }

    return {
      kind: "IfStatement",
      condition,
      consequent: consequentBlock.statements,
      alternate,
      span: { start, end },
    };
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

  private parseAssignment(requireSemicolon: boolean): AssignmentStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const opToken = this.advance();
    let operator: "=" | "+=" | "-=";
    if (opToken.kind === TokenKind.Equal) {
      operator = "=";
    } else if (opToken.kind === TokenKind.PlusEqual) {
      operator = "+=";
    } else if (opToken.kind === TokenKind.MinusEqual) {
      operator = "-=";
    } else {
      this.diagnostics.error("Expected '=', '+=', or '-=' in assignment", opToken.span, "E0103");
      return null;
    }

    const value = this.parseExpression();
    if (!value) {
      return null;
    }

    let end = value.span.end;
    if (requireSemicolon) {
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after assignment");
      end = semicolon?.span.end ?? value.span.end;
    }

    return {
      kind: "AssignmentStatement",
      name,
      operator,
      value,
      span: { start, end },
    };
  }

  private parseUpdateStatement(requireSemicolon: boolean): UpdateStatement | null {
    const start = this.peek().span.start;
    const nameToken = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.lexeme,
      span: nameToken.span,
    };

    const opToken = this.advance();
    let operator: "++" | "--";
    if (opToken.kind === TokenKind.PlusPlus) {
      operator = "++";
    } else if (opToken.kind === TokenKind.MinusMinus) {
      operator = "--";
    } else {
      this.diagnostics.error("Expected '++' or '--'", opToken.span, "E0103");
      return null;
    }

    let end = opToken.span.end;
    if (requireSemicolon) {
      const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after update");
      end = semicolon?.span.end ?? opToken.span.end;
    }

    return {
      kind: "UpdateStatement",
      name,
      operator,
      span: { start, end },
    };
  }

  private parseReturnStatement(): ReturnStatement | null {
    const start = this.peek().span.start;
    this.advance(); // return

    let value: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      value = this.parseExpression();
      if (!value) {
        return null;
      }
    }

    const semicolon = this.expect(TokenKind.Semicolon, "Expected ';' after return");
    const end = semicolon?.span.end ?? value?.span.end ?? this.peek().span.end;

    return {
      kind: "ReturnStatement",
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
    return this.parseOr();
  }

  private parseOr(): Expression | null {
    let left = this.parseAnd();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.PipePipe)) {
      const opToken = this.advance();
      const right = this.parseAnd();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseAnd(): Expression | null {
    let left = this.parseEquality();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.AmpAmp)) {
      const opToken = this.advance();
      const right = this.parseEquality();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseEquality(): Expression | null {
    let left = this.parseRelational();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.EqualEqual) || this.check(TokenKind.BangEqual)) {
      const opToken = this.advance();
      const right = this.parseRelational();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseRelational(): Expression | null {
    let left = this.parseAdditive();
    if (!left) {
      return null;
    }

    while (
      this.check(TokenKind.Less) ||
      this.check(TokenKind.LessEqual) ||
      this.check(TokenKind.Greater) ||
      this.check(TokenKind.GreaterEqual)
    ) {
      const opToken = this.advance();
      const right = this.parseAdditive();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator: opToken.lexeme as BinaryOperator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseAdditive(): Expression | null {
    let left = this.parseMultiplicative();
    if (!left) {
      return null;
    }

    while (this.check(TokenKind.Plus) || this.check(TokenKind.Minus)) {
      const opToken = this.advance();
      const operator = opToken.lexeme as BinaryOperator;
      const right = this.parseMultiplicative();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseMultiplicative(): Expression | null {
    let left = this.parseUnary();
    if (!left) {
      return null;
    }

    while (
      this.check(TokenKind.Star) ||
      this.check(TokenKind.Slash) ||
      this.check(TokenKind.Percent)
    ) {
      const opToken = this.advance();
      const operator = opToken.lexeme as BinaryOperator;
      const right = this.parseUnary();
      if (!right) {
        return null;
      }
      const binary: BinaryExpression = {
        kind: "BinaryExpression",
        operator,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }

    return left;
  }

  private parseUnary(): Expression | null {
    if (this.check(TokenKind.Minus) || this.check(TokenKind.Bang)) {
      const opToken = this.advance();
      const operand = this.parseUnary();
      if (!operand) {
        return null;
      }
      const unary: UnaryExpression = {
        kind: "UnaryExpression",
        operator: opToken.lexeme as "-" | "!",
        operand,
        span: { start: opToken.span.start, end: operand.span.end },
      };
      return unary;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): Expression | null {
    if (this.check(TokenKind.LParen)) {
      this.advance();
      const expr = this.parseExpression();
      if (!expr) {
        return null;
      }
      if (!this.expect(TokenKind.RParen, "Expected ')' after expression")) {
        return null;
      }
      return expr;
    }

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
      if (this.check(TokenKind.Function)) {
        return;
      }
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
