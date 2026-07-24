/** A dependency declared in project.toml. */
export type DepSpec =
  | { readonly kind: "version"; readonly range: string }
  | { readonly kind: "path"; readonly path: string };

export function isVersionDep(
  spec: DepSpec,
): spec is Extract<DepSpec, { kind: "version" }> {
  return spec.kind === "version";
}

export function isPathDep(
  spec: DepSpec,
): spec is Extract<DepSpec, { kind: "path" }> {
  return spec.kind === "path";
}

/** Registry version requirements only (drops path deps). */
export function versionRangeMap(
  deps: Readonly<Record<string, DepSpec>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.kind === "version") {
      out[name] = spec.range;
    }
  }
  return out;
}

/** Serialize a DepSpec for writing back to project.toml. */
export function formatDepSpecToml(spec: DepSpec): string {
  if (spec.kind === "version") {
    return JSON.stringify(spec.range);
  }
  return `{ path = ${JSON.stringify(spec.path)} }`;
}

export function pathLockSource(absolutePath: string): string {
  return `path:${absolutePath}`;
}

export function isPathLockSource(source: string): boolean {
  return source.startsWith("path:");
}

export function pathFromLockSource(source: string): string {
  return source.slice("path:".length);
}
