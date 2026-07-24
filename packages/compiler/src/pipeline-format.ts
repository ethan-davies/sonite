import type { Diagnostic } from "./diagnostics/diagnostic.js";

export function formatDiagnostics(diagnostics: readonly Diagnostic[], fileName = "<source>"): string {
  return diagnostics
    .map((d) => {
      const path = d.file ?? fileName;
      const loc = d.span
        ? `${path}:${d.span.start.line}:${d.span.start.column}`
        : path;
      const code = d.code ? ` [${d.code}]` : "";
      let line = `${loc}: ${d.severity}${code}: ${d.message}`;
      if (d.suggestions && d.suggestions.length > 0) {
        const hint =
          d.suggestions.length === 1
            ? `Did you mean '${d.suggestions[0]}'?`
            : `Did you mean ${d.suggestions.map((s) => `'${s}'`).join(", ")}?`;
        line += `\n${loc}: note: ${hint}`;
      }
      return line;
    })
    .join("\n");
}
