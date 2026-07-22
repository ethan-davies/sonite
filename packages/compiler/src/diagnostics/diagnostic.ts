/** Source location within a file (1-based line/column). */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

/** Span covering a contiguous region of source text. */
export interface SourceSpan {
  readonly start: SourceLocation;
  readonly end: SourceLocation;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly code?: string;
  /** Absolute or logical path of the file this diagnostic belongs to. */
  readonly file?: string;
}

export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];
  private activeFile: string | undefined;

  /** Stamp subsequent diagnostics with this file path (cleared by `clearFile`). */
  setFile(file: string | undefined): void {
    this.activeFile = file;
  }

  clearFile(): void {
    this.activeFile = undefined;
  }

  get file(): string | undefined {
    return this.activeFile;
  }

  error(message: string, span?: SourceSpan, code?: string): void {
    this.push("error", message, span, code);
  }

  warning(message: string, span?: SourceSpan, code?: string): void {
    this.push("warning", message, span, code);
  }

  info(message: string, span?: SourceSpan, code?: string): void {
    this.push("info", message, span, code);
  }

  private push(
    severity: DiagnosticSeverity,
    message: string,
    span?: SourceSpan,
    code?: string,
  ): void {
    this.items.push({
      severity,
      message,
      ...(span ? { span } : {}),
      ...(code ? { code } : {}),
      ...(this.activeFile !== undefined ? { file: this.activeFile } : {}),
    });
  }

  get diagnostics(): readonly Diagnostic[] {
    return this.items;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  /** Discard diagnostics beyond `length` (used for speculative parses). */
  truncate(length: number): void {
    if (length < this.items.length) {
      this.items.length = length;
    }
  }

  format(fileName = "<source>"): string {
    return this.items
      .map((d) => {
        const path = d.file ?? fileName;
        const loc = d.span
          ? `${path}:${d.span.start.line}:${d.span.start.column}`
          : path;
        const code = d.code ? ` [${d.code}]` : "";
        return `${loc}: ${d.severity}${code}: ${d.message}`;
      })
      .join("\n");
  }
}
