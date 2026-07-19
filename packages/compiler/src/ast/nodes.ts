import type { SourceSpan } from "../diagnostics/diagnostic.js";

export type PrimitiveTypeName =
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "bool"
  | "string"
  | "char"
  | "void";

export type AstNode =
  | Program
  | FunctionDeclaration
  | VariableDeclaration
  | AssignmentStatement
  | ExpressionStatement
  | CallExpression
  | BinaryExpression
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral
  | TypeAnnotation;

interface AstNodeBase {
  readonly kind: string;
  readonly span: SourceSpan;
}

export interface Program extends AstNodeBase {
  readonly kind: "Program";
  readonly body: FunctionDeclaration[];
}

export type Statement = VariableDeclaration | AssignmentStatement | ExpressionStatement;

export interface FunctionDeclaration extends AstNodeBase {
  readonly kind: "FunctionDeclaration";
  readonly name: Identifier;
  readonly returnType: TypeAnnotation;
  readonly body: Statement[];
}

export interface VariableDeclaration extends AstNodeBase {
  readonly kind: "VariableDeclaration";
  readonly mutability: "let" | "const";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly initializer: Expression;
}

export interface AssignmentStatement extends AstNodeBase {
  readonly kind: "AssignmentStatement";
  readonly name: Identifier;
  readonly value: Expression;
}

export interface ExpressionStatement extends AstNodeBase {
  readonly kind: "ExpressionStatement";
  readonly expression: Expression;
}

export type Expression =
  | CallExpression
  | BinaryExpression
  | Identifier
  | StringLiteral
  | IntegerLiteral
  | FloatLiteral
  | BooleanLiteral
  | CharLiteral;

export interface CallExpression extends AstNodeBase {
  readonly kind: "CallExpression";
  readonly callee: Identifier;
  readonly args: Expression[];
}

export interface BinaryExpression extends AstNodeBase {
  readonly kind: "BinaryExpression";
  readonly operator: "+";
  readonly left: Expression;
  readonly right: Expression;
}

export interface Identifier extends AstNodeBase {
  readonly kind: "Identifier";
  readonly name: string;
}

export interface StringLiteral extends AstNodeBase {
  readonly kind: "StringLiteral";
  /** Decoded string contents (quotes stripped, escapes resolved). */
  readonly value: string;
  /** Original lexeme including quotes. */
  readonly raw: string;
}

export interface IntegerLiteral extends AstNodeBase {
  readonly kind: "IntegerLiteral";
  readonly value: number;
  readonly raw: string;
}

export interface FloatLiteral extends AstNodeBase {
  readonly kind: "FloatLiteral";
  readonly value: number;
  readonly raw: string;
}

export interface BooleanLiteral extends AstNodeBase {
  readonly kind: "BooleanLiteral";
  readonly value: boolean;
}

export interface CharLiteral extends AstNodeBase {
  readonly kind: "CharLiteral";
  readonly value: string;
  readonly raw: string;
}

export interface TypeAnnotation extends AstNodeBase {
  readonly kind: "TypeAnnotation";
  readonly name: PrimitiveTypeName;
}
