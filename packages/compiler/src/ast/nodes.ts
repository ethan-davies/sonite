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

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export type AstNode =
  | Program
  | FunctionDeclaration
  | Parameter
  | VariableDeclaration
  | AssignmentStatement
  | ExpressionStatement
  | ReturnStatement
  | IfStatement
  | CallExpression
  | BinaryExpression
  | UnaryExpression
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

export type Statement =
  | VariableDeclaration
  | AssignmentStatement
  | ExpressionStatement
  | ReturnStatement
  | IfStatement;

export interface Parameter extends AstNodeBase {
  readonly kind: "Parameter";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation;
}

export interface FunctionDeclaration extends AstNodeBase {
  readonly kind: "FunctionDeclaration";
  readonly name: Identifier;
  readonly params: Parameter[];
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

export interface ReturnStatement extends AstNodeBase {
  readonly kind: "ReturnStatement";
  readonly value: Expression | null;
}

export interface IfStatement extends AstNodeBase {
  readonly kind: "IfStatement";
  readonly condition: Expression;
  readonly consequent: Statement[];
  /** elseif → nested IfStatement; else { } → Statement[]; bare if → null */
  readonly alternate: IfStatement | Statement[] | null;
}

export type Expression =
  | CallExpression
  | BinaryExpression
  | UnaryExpression
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
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpression extends AstNodeBase {
  readonly kind: "UnaryExpression";
  readonly operator: "-" | "!";
  readonly operand: Expression;
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
