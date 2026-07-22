import type { Diagnostic } from "./diagnostics/diagnostic.js";

export function formatDiagnostics(diagnostics: readonly Diagnostic[], fileName = "<source>"): string {
  return diagnostics
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
