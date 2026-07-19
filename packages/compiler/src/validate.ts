import type { Program } from "./ast/nodes.js";
import type { DiagnosticCollector } from "./diagnostics/diagnostic.js";

/**
 * Semantic checks for program shape beyond pure grammar.
 */
export function validate(program: Program, diagnostics: DiagnosticCollector): void {
  if (program.body.length === 0) {
    diagnostics.error("Program must define a main() function", program.span, "E0200");
    return;
  }

  const mains = program.body.filter((fn) => fn.name.name === "main");
  if (mains.length === 0) {
    const first = program.body[0];
    diagnostics.error(
      `Entry function must be named 'main', found '${first?.name.name ?? "?"}'`,
      first?.name.span ?? program.span,
      "E0202",
    );
    return;
  }

  if (mains.length > 1) {
    const extra = mains[1];
    diagnostics.error(
      "Only one 'main' function is allowed",
      extra?.name.span ?? program.span,
      "E0201",
    );
  }

  const main = mains[0];
  if (!main) {
    return;
  }

  if (main.params.length > 0) {
    diagnostics.error(
      "Entry function 'main' must not take parameters",
      main.params[0]?.span ?? main.name.span,
      "E0206",
    );
  }

  if (main.returnType.name !== "void") {
    diagnostics.error(
      `Entry function 'main' must return 'void', found '${main.returnType.name}'`,
      main.returnType.span,
      "E0205",
    );
  }
}
