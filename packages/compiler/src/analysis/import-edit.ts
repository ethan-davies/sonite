import type { ImportDeclaration, Program } from "../ast/nodes.js";
import type { SourceSpan } from "../diagnostics/diagnostic.js";

export interface ImportTextEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

/**
 * Compute a text edit that adds `exportName` via a named import from
 * `moduleSpecifier`, merging into an existing named import when possible.
 */
export function computeNamedImportEdit(
  source: string,
  ast: Program | undefined,
  moduleSpecifier: string,
  exportName: string,
): ImportTextEdit | null {
  if (ast) {
    for (const decl of ast.body) {
      if (decl.kind !== "ImportDeclaration") {
        continue;
      }
      if (decl.source.value !== moduleSpecifier) {
        continue;
      }
      if (decl.clause.kind !== "NamedImports") {
        continue;
      }
      const already = decl.clause.specifiers.some(
        (s) => s.importedName.name === exportName || s.localName.name === exportName,
      );
      if (already) {
        return null;
      }
      return mergeIntoNamedImport(source, decl, exportName);
    }
  }

  const insertOffset = importInsertOffset(source, ast);
  const line = `import { ${exportName} } from "${moduleSpecifier}";\n`;
  return {
    startOffset: insertOffset,
    endOffset: insertOffset,
    newText: line,
  };
}

function mergeIntoNamedImport(
  source: string,
  decl: ImportDeclaration,
  exportName: string,
): ImportTextEdit | null {
  if (decl.clause.kind !== "NamedImports") {
    return null;
  }
  const specs = decl.clause.specifiers;
  if (specs.length === 0) {
    // import { } from "..." — rare; rewrite the whole declaration.
    const newText = `import { ${exportName} } from "${decl.source.value}";`;
    return {
      startOffset: decl.span.start.offset,
      endOffset: decl.span.end.offset,
      newText,
    };
  }

  const last = specs[specs.length - 1]!;
  const insertAt = last.span.end.offset;
  // Insert `, exportName` before the closing `}` — after the last specifier.
  return {
    startOffset: insertAt,
    endOffset: insertAt,
    newText: `, ${exportName}`,
  };
}

function importInsertOffset(source: string, ast: Program | undefined): number {
  if (ast) {
    let lastImportEnd = 0;
    let sawImport = false;
    for (const decl of ast.body) {
      if (decl.kind === "ImportDeclaration") {
        lastImportEnd = decl.span.end.offset;
        sawImport = true;
      } else if (sawImport) {
        break;
      }
    }
    if (sawImport) {
      // Place after the last import line (consume trailing newline if present).
      let offset = lastImportEnd;
      if (source[offset] === "\r") {
        offset += 1;
      }
      if (source[offset] === "\n") {
        offset += 1;
      }
      return offset;
    }
  }

  // Skip leading shebang / blank lines.
  let offset = 0;
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    offset = nl >= 0 ? nl + 1 : source.length;
  }
  return offset;
}

export function offsetToPosition(
  source: string,
  offset: number,
): { line: number; character: number } {
  let line = 0;
  let character = 0;
  const clamped = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < clamped; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

export type { SourceSpan };
