import { loadLockfile } from "../deps/lock.js";
import { loadProject, ProjectError } from "../project.js";
import { RegistryError } from "../registry/client.js";
import { auditPackages, type Advisory } from "../registry/packages.js";

function severityRank(severity: Advisory["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "moderate":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

/**
 * Check locked dependencies against the registry advisory database.
 * Exits non-zero when any advisories are found (CI-friendly).
 */
export async function runAudit(): Promise<number> {
  try {
    let project;
    try {
      project = loadProject();
    } catch (error) {
      if (error instanceof ProjectError) {
        console.error(`error: ${error.message}`);
        return 1;
      }
      throw error;
    }

    const lock = loadLockfile(project.root);
    if (!lock || lock.packages.length === 0) {
      console.log("no locked dependencies to audit");
      return 0;
    }

    const packages = lock.packages
      .filter((p) => !p.source.startsWith("path:"))
      .map((p) => ({ name: p.name, version: p.version }));

    if (packages.length === 0) {
      console.log("no registry packages to audit");
      return 0;
    }

    const result = await auditPackages(packages);
    const advisories = [...result.advisories].sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.packageName.localeCompare(b.packageName),
    );

    if (advisories.length === 0) {
      console.log("No known vulnerabilities found.");
      return 0;
    }

    // Group by package@version for display
    const byPkg = new Map<string, Advisory[]>();
    for (const adv of advisories) {
      const key = `${adv.packageName}`;
      const list = byPkg.get(key) ?? [];
      list.push(adv);
      byPkg.set(key, list);
    }

    const affected = new Set(advisories.map((a) => a.packageName));
    console.log(
      `${affected.size} dependencies have known security issues.`,
    );
    console.log("");

    for (const pkg of packages) {
      const matches = advisories.filter(
        (a) => a.packageName === pkg.name,
      );
      if (matches.length === 0) continue;
      console.log(`${pkg.name}@${pkg.version}`);
      for (const adv of matches) {
        console.log(`  Advisory: ${adv.advisoryId}`);
        console.log(`  Severity: ${capitalize(adv.severity)}`);
        console.log(`  ${adv.title}`);
        if (adv.fixedIn) {
          console.log(`  Fixed in: ${adv.fixedIn}`);
        }
        console.log("");
      }
    }

    return 1;
  } catch (error) {
    const message =
      error instanceof RegistryError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`error: ${message}`);
    return 1;
  }
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
