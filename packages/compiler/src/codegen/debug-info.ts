import type { SourceSpan } from "../diagnostics/diagnostic.js";
import { basename, dirname } from "node:path";

/**
 * Allocates LLVM metadata node IDs and formats DWARF-ish debug info as textual IR.
 * Consumed by string-based codegen (parsed via LLVMParseIR).
 */
export class DebugInfoBuilder {
  private nextId = 0;
  private readonly nodes: string[] = [];
  private compileUnitId: number | null = null;
  private fileIds = new Map<string, number>();
  private readonly emptyExprId: number;

  constructor() {
    this.emptyExprId = this.alloc(`!{}`);
  }

  private alloc(body: string): number {
    const id = this.nextId;
    this.nextId += 1;
    this.nodes.push(`!${id} = ${body}`);
    return id;
  }

  /** Ensure a compile unit exists for the primary source file. */
  ensureCompileUnit(sourcePath: string): number {
    if (this.compileUnitId !== null) {
      return this.compileUnitId;
    }
    const fileId = this.file(sourcePath);
    this.compileUnitId = this.alloc(
      `distinct !DICompileUnit(language: DW_LANG_C_plus_plus, file: !${fileId}, producer: "sonite", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug, enums: !${this.emptyExprId})`,
    );
    return this.compileUnitId;
  }

  file(sourcePath: string): number {
    const normalized = sourcePath.replace(/\\/g, "/");
    const existing = this.fileIds.get(normalized);
    if (existing !== undefined) {
      return existing;
    }
    const fileName = basename(normalized) || "sonite";
    const directory = dirname(normalized);
    const dir =
      directory === "." || directory === ""
        ? ""
        : directory === "/"
          ? "/"
          : directory;
    const id = this.alloc(
      `!DIFile(filename: ${llvmQuote(fileName)}, directory: ${llvmQuote(dir)})`,
    );
    this.fileIds.set(normalized, id);
    return id;
  }

  subprogram(
    name: string,
    sourcePath: string,
    line: number,
  ): number {
    const cu = this.ensureCompileUnit(sourcePath);
    const fileId = this.file(sourcePath);
    const typeId = this.alloc(
      `!DISubroutineType(types: !${this.emptyExprId})`,
    );
    return this.alloc(
      `distinct !DISubprogram(name: ${llvmQuote(name)}, scope: !${fileId}, file: !${fileId}, line: ${Math.max(1, line)}, type: !${typeId}, scopeLine: ${Math.max(1, line)}, spFlags: DISPFlagDefinition, unit: !${cu})`,
    );
  }

  lexicalBlock(
    parentScope: number,
    sourcePath: string,
    span: SourceSpan,
  ): number {
    const fileId = this.file(sourcePath);
    return this.alloc(
      `distinct !DILexicalBlock(scope: !${parentScope}, file: !${fileId}, line: ${span.start.line}, column: ${span.start.column})`,
    );
  }

  location(scope: number, span: SourceSpan): number {
    return this.alloc(
      `!DILocation(line: ${span.start.line}, column: ${span.start.column}, scope: !${scope})`,
    );
  }

  /** Module-level named metadata + all DI nodes. */
  emitFooter(): string[] {
    if (this.compileUnitId === null) {
      return [];
    }
    const dwarfFlag = this.alloc(`!{i32 7, !"Dwarf Version", i32 4}`);
    const diFlag = this.alloc(`!{i32 2, !"Debug Info Version", i32 3}`);
    const wcharFlag = this.alloc(`!{i32 1, !"wchar_size", i32 4}`);
    const ident = this.alloc(`!{!"sonite"}`);
    return [
      "",
      `!llvm.dbg.cu = !{!${this.compileUnitId}}`,
      `!llvm.module.flags = !{!${dwarfFlag}, !${diFlag}, !${wcharFlag}}`,
      `!llvm.ident = !{!${ident}}`,
      "",
      ...this.nodes,
    ];
  }

  get enabled(): boolean {
    return true;
  }
}

function llvmQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Attach `!dbg !N` to an LLVM instruction line when missing. */
export function attachDbg(line: string, dbgId: number): string {
  if (!line || line.includes("!dbg ") || !/^\s+/.test(line)) {
    return line;
  }
  // Labels and comments are not instructions.
  if (/^\s+[A-Za-z0-9_.]+:\s*$/.test(line) || /^\s*;/.test(line)) {
    return line;
  }
  const trimmed = line.trimStart();
  if (
    !(
      trimmed.startsWith("%") ||
      trimmed.startsWith("store ") ||
      trimmed.startsWith("call ") ||
      trimmed.startsWith("invoke ") ||
      trimmed.startsWith("br ") ||
      trimmed.startsWith("ret ") ||
      trimmed.startsWith("unreachable") ||
      trimmed.startsWith("switch ") ||
      trimmed.startsWith("indirectbr ") ||
      trimmed.startsWith("resume ") ||
      trimmed.startsWith("landingpad ") ||
      trimmed.startsWith("fence ") ||
      trimmed.startsWith("atomicrmw ") ||
      trimmed.startsWith("cmpxchg ")
    )
  ) {
    return line;
  }
  // Insert before any existing trailing comment.
  const commentIdx = line.indexOf(";");
  if (commentIdx >= 0) {
    const code = line.slice(0, commentIdx).trimEnd();
    const comment = line.slice(commentIdx);
    return `${code}, !dbg !${dbgId} ${comment}`;
  }
  return `${line.trimEnd()}, !dbg !${dbgId}`;
}

export function attachDbgToDefine(header: string, subprogramId: number): string {
  // `define ... {` → `define ... !dbg !N {`
  if (header.includes("!dbg ")) {
    return header;
  }
  return header.replace(/\s*\{\s*$/, ` !dbg !${subprogramId} {`);
}
