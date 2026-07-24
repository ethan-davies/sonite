import { loadLockfile } from "../deps/lock.js";
import { isPathLockSource, pathFromLockSource } from "../deps/types.js";
import { loadProject, ProjectError } from "../project.js";

/**
 * Print the locked dependency tree for the current project.
 */
export function runTree(): number {
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
    console.log(`${project.package.name}`);
    console.log("(no locked dependencies)");
    return 0;
  }

  const byName = new Map(lock.packages.map((p) => [p.name, p]));
  const rootNames = new Set([
    ...Object.keys(project.dependencies),
    ...Object.keys(project.devDependencies),
  ]);

  // Prefer declared roots that appear in the lock; otherwise all packages
  // that are not depended on by another locked package.
  const dependedOn = new Set<string>();
  for (const pkg of lock.packages) {
    for (const dep of pkg.dependencies) {
      dependedOn.add(dep);
    }
  }
  const roots = [...rootNames]
    .filter((n) => byName.has(n))
    .sort((a, b) => a.localeCompare(b));
  const displayRoots =
    roots.length > 0
      ? roots
      : lock.packages
          .filter((p) => !dependedOn.has(p.name))
          .map((p) => p.name)
          .sort((a, b) => a.localeCompare(b));

  console.log(project.package.name);

  const visited = new Set<string>();
  function printNode(
    name: string,
    prefix: string,
    isLast: boolean,
    ancestry: Set<string>,
  ): void {
    const pkg = byName.get(name);
    if (!pkg) {
      return;
    }
    const connector = isLast ? "└── " : "├── ";
    const flags: string[] = [];
    if (pkg.dev) flags.push("dev");
    if (pkg.override) flags.push("override");
    const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
    let sourceNote = "";
    if (isPathLockSource(pkg.source)) {
      sourceNote = ` (path: ${pathFromLockSource(pkg.source)})`;
    }
    console.log(
      `${prefix}${connector}${pkg.name}@${pkg.version}${flagStr}${sourceNote}`,
    );

    if (ancestry.has(name) || visited.has(`${[...ancestry].join(">")}>${name}`)) {
      return;
    }
    visited.add(`${[...ancestry].join(">")}>${name}`);

    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(name);
    const children = [...pkg.dependencies].sort((a, b) => a.localeCompare(b));
    children.forEach((child, index) => {
      printNode(child, childPrefix, index === children.length - 1, nextAncestry);
    });
  }

  displayRoots.forEach((name, index) => {
    printNode(name, "", index === displayRoots.length - 1, new Set());
  });

  // Native artifacts
  if (lock.natives.length > 0) {
    console.log("");
    console.log("Native:");
    for (const native of [...lock.natives].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      console.log(
        `  ${native.name}@${native.version} (${native.platform}-${native.architecture}, ${native.kind}) via ${native.package}`,
      );
    }
  }

  // Duplicate-version detection across names is N/A (one version per name),
  // but report packages used by multiple parents.
  const usedBy = new Map<string, string[]>();
  for (const pkg of lock.packages) {
    for (const dep of pkg.dependencies) {
      const list = usedBy.get(dep) ?? [];
      list.push(pkg.name);
      usedBy.set(dep, list);
    }
  }
  const shared = [...usedBy.entries()]
    .filter(([, parents]) => parents.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (shared.length > 0) {
    console.log("");
    console.log("Shared dependencies:");
    for (const [name, parents] of shared) {
      const pkg = byName.get(name);
      if (!pkg) continue;
      console.log(`${pkg.name}@${pkg.version}`);
      for (const parent of parents.sort()) {
        console.log(`  used by ${parent}`);
      }
    }
  }

  return 0;
}
