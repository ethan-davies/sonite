import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { ProjectError, type Project } from "../project.js";
import { parseVersionRequirement } from "./semver.js";
import {
  formatDepSpecToml,
  type DepSpec,
} from "./types.js";

const PACKAGE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,213})$/;

export function isValidPackageName(name: string): boolean {
  return PACKAGE_NAME_RE.test(name);
}

export function parsePackageSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  const at = spec.lastIndexOf("@");
  // Allow scoped-looking names without npm scopes; only split version after @.
  if (at > 0) {
    return {
      name: spec.slice(0, at),
      version: spec.slice(at + 1) || undefined,
    };
  }
  return { name: spec, version: undefined };
}

/**
 * Rewrite `[dependencies]` in project.toml while preserving other content when possible.
 */
export function writeDependencies(
  project: Project,
  dependencies: Record<string, DepSpec>,
): void {
  writeDepSection(project.manifestPath, "dependencies", dependencies);
}

export function writeDevDependencies(
  project: Project,
  dependencies: Record<string, DepSpec>,
): void {
  writeDepSection(project.manifestPath, "dev-dependencies", dependencies);
}

function writeDepSection(
  manifestPath: string,
  section: "dependencies" | "dev-dependencies",
  dependencies: Record<string, DepSpec>,
): void {
  const sortedKeys = Object.keys(dependencies).sort();
  const depsBlock =
    sortedKeys.length === 0
      ? `[${section}]\n`
      : `[${section}]\n${sortedKeys
          .map((k) => `${k} = ${formatDepSpecToml(dependencies[k]!)}`)
          .join("\n")}\n`;

  const original = readFileSync(manifestPath, "utf8");
  const sectionRe = new RegExp(
    `(^|\\n)\\[${section.replace("-", "\\-")}\\][^\\n]*\\n(?:(?!\\[[^\\]]+\\]).*\\n?)*`,
    "m",
  );
  const depsMatch = original.match(sectionRe);

  let next: string;
  if (depsMatch && depsMatch.index !== undefined) {
    const start = depsMatch.index + (depsMatch[1] === "\n" ? 1 : 0);
    const end = start + depsMatch[0].length - (depsMatch[1] === "\n" ? 1 : 0);
    const before = original.slice(0, start);
    const after = original.slice(end);
    next = `${before.replace(/\n*$/, "\n")}${depsBlock}${after.replace(/^\n*/, "\n")}`.replace(
      /\n{3,}/g,
      "\n\n",
    );
  } else {
    next = `${original.replace(/\s*$/, "\n\n")}${depsBlock}`;
  }

  try {
    parseToml(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`failed to write ${section}: ${message}`);
  }

  writeFileSync(manifestPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}

export function setDependency(
  project: Project,
  name: string,
  versionRequirement: string,
): Record<string, DepSpec> {
  if (!isValidPackageName(name)) {
    throw new ProjectError(`invalid package name '${name}'`);
  }
  parseVersionRequirement(versionRequirement);
  const next: Record<string, DepSpec> = {
    ...project.dependencies,
    [name]: { kind: "version", range: versionRequirement },
  };
  writeDependencies(project, next);
  return next;
}

export function removeDependency(
  project: Project,
  name: string,
): Record<string, DepSpec> {
  if (!(name in project.dependencies) && !(name in project.devDependencies)) {
    throw new ProjectError(`dependency '${name}' is not in project.toml`);
  }
  if (name in project.dependencies) {
    const next = { ...project.dependencies };
    delete next[name];
    writeDependencies(project, next);
    return next;
  }
  const next = { ...project.devDependencies };
  delete next[name];
  writeDevDependencies(project, next);
  return next;
}
