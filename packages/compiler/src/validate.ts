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

  if (program.body.length > 1) {
    const extra = program.body[1];
    diagnostics.error(
      "Only one top-level function is allowed",
      extra?.span ?? program.span,
      "E0201",
    );
  }

  const fn = program.body[0];
  if (!fn) {
    return;
  }

  if (fn.name.name !== "main") {
    diagnostics.error(
      `Entry function must be named 'main', found '${fn.name.name}'`,
      fn.name.span,
      "E0202",
    );
  }

  if (fn.returnType.name !== "void") {
    diagnostics.error(
      `Entry function 'main' must return 'void', found '${fn.returnType.name}'`,
      fn.returnType.span,
      "E0205",
    );
  }
}
