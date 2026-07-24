export { DiagnosticCollector } from "./diagnostic.js";
export type {
  Diagnostic,
  DiagnosticSeverity,
  SourceLocation,
  SourceSpan,
} from "./diagnostic.js";
export {
  applyDiagnosticsConfig,
  DEFAULT_DIAGNOSTICS_CONFIG,
  DIAGNOSTIC_CODES,
  diagnosticsHaveErrors,
  loadDiagnosticsOptions,
  parseDiagnosticsSection,
  promoteWarningsAsErrors,
  resolveDiagnosticsConfig,
} from "./config.js";
export type { DiagnosticLevel, DiagnosticsConfig } from "./config.js";
