import semver from "semver";
import { ProjectError } from "../project.js";

/**
 * Sonite dependency version requirements (v1).
 *
 * Supported forms in project.toml:
 * - `1.2.3`  — exact: only that version
 * - `^1.2.3` — caret: compatible releases (>=1.2.3 <2.0.0); for 0.x follows npm caret rules
 * - `~1.2.3` — tilde: patch-level (>=1.2.3 <1.3.0); for ~1.2 follows npm tilde rules
 *
 * Not yet supported: `>=`, `<=`, ranges with spaces, `*`, etc.
 */
export type RequirementKind = "exact" | "caret" | "tilde";

export interface VersionRequirement {
  readonly raw: string;
  readonly kind: RequirementKind;
  /** Normalized range understood by the `semver` package (e.g. `^1.2.3`). */
  readonly range: string;
}

const EXACT_RE = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const CARET_RE = /^\^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const TILDE_RE = /^~(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function parseVersionRequirement(raw: string): VersionRequirement {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProjectError("version requirement must not be empty");
  }

  if (trimmed.startsWith(">=") || trimmed.startsWith("<=") || trimmed.startsWith(">") || trimmed.startsWith("<") || trimmed.includes("||") || trimmed.includes(" - ") || trimmed === "*" || trimmed.startsWith("=")) {
    throw new ProjectError(
      `unsupported version requirement '${trimmed}' (supported: exact, ^, ~)`,
    );
  }

  let kind: RequirementKind;
  let version: string;
  if (CARET_RE.test(trimmed)) {
    kind = "caret";
    version = trimmed.slice(1);
  } else if (TILDE_RE.test(trimmed)) {
    kind = "tilde";
    version = trimmed.slice(1);
  } else if (EXACT_RE.test(trimmed)) {
    kind = "exact";
    version = trimmed;
  } else {
    throw new ProjectError(
      `invalid version requirement '${trimmed}' (expected semver like 1.2.3, ^1.2.3, or ~1.2.3)`,
    );
  }

  if (!semver.valid(version)) {
    throw new ProjectError(`invalid semver version in requirement '${trimmed}'`);
  }

  const range =
    kind === "exact" ? version : kind === "caret" ? `^${version}` : `~${version}`;

  // Validate the range parses.
  if (!semver.validRange(range)) {
    throw new ProjectError(`invalid version range '${trimmed}'`);
  }

  return { raw: trimmed, kind, range };
}

export function isValidSemverVersion(version: string): boolean {
  return semver.valid(version) !== null;
}

export function versionSatisfies(
  version: string,
  requirement: VersionRequirement | string,
): boolean {
  const req =
    typeof requirement === "string"
      ? parseVersionRequirement(requirement)
      : requirement;
  return semver.satisfies(version, req.range, { includePrerelease: false });
}

/** Highest version in `versions` that satisfies `requirement`, or null. */
export function maxSatisfying(
  versions: readonly string[],
  requirement: VersionRequirement | string,
): string | null {
  const req =
    typeof requirement === "string"
      ? parseVersionRequirement(requirement)
      : requirement;
  return semver.maxSatisfying([...versions], req.range, {
    includePrerelease: false,
  });
}

/** True if every version that satisfies `a` also… — used for range intersection checks via candidate filtering. */
export function versionsMatchingAll(
  versions: readonly string[],
  requirements: readonly (VersionRequirement | string)[],
): string[] {
  const reqs = requirements.map((r) =>
    typeof r === "string" ? parseVersionRequirement(r) : r,
  );
  return versions
    .filter((v) => semver.valid(v))
    .filter((v) => reqs.every((r) => semver.satisfies(v, r.range)))
    .sort(semver.rcompare);
}

export function caretOf(version: string): string {
  if (!semver.valid(version)) {
    throw new ProjectError(`invalid semver version '${version}'`);
  }
  return `^${version}`;
}
