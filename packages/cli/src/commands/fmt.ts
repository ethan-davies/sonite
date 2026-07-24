import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, relative, sep } from "node:path";
import {
  formatDiagnostics,
  formatSource,
  loadFormatOptions,
} from "@sonite/compiler";
import { findProjectManifest, loadProject } from "../project.js";

export interface FmtOptions {
  readonly paths: readonly string[];
  readonly check: boolean;
  readonly write: boolean;
  readonly changed?: boolean;
}

export function runFmt(options: FmtOptions): number {
  if (options.paths.length === 1 && options.paths[0] === "-") {
    if (options.changed) {
      console.error("error: --changed cannot be used with stdin");
      return 1;
    }
    return formatStdin(options);
  }

  const formatOpts = loadFormatOptions(process.cwd());
  let files: string[];
  if (options.changed) {
    const changed = collectChangedSnFiles();
    if (changed === null) {
      return 1;
    }
    if (options.paths.length > 0) {
      const explicit = new Set(collectFiles(options.paths));
      files = changed.filter((f) => explicit.has(f));
    } else {
      files = changed;
    }
  } else {
    files = collectFiles(options.paths);
  }

  if (files.length === 0) {
    if (options.changed) {
      console.log("no changed .sn files to format");
      return 0;
    }
    console.error("error: no .sn files to format");
    return 1;
  }

  let failures = 0;
  let changed = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const result = formatSource(source, { ...formatOpts, fileName: file });
    if (!result.success || result.code === null) {
      const formatted = formatDiagnostics(result.diagnostics, file);
      if (formatted) {
        console.error(formatted);
      } else {
        console.error(`error: failed to format ${file}`);
      }
      failures++;
      continue;
    }

    if (result.code === source) {
      continue;
    }

    if (options.check) {
      console.error(`would reformat ${file}`);
      changed++;
      continue;
    }

    // Default writes; --write is an explicit alias of the same behavior.
    writeFileSync(file, result.code, "utf8");
    console.log(`formatted ${file}`);
    changed++;
  }

  if (failures > 0) {
    return 1;
  }
  if (options.check && changed > 0) {
    return 1;
  }
  if (options.check && changed === 0) {
    console.log(`${files.length} file(s) already formatted`);
  }
  return 0;
}

function formatStdin(options: FmtOptions): number {
  const source = readFileSync(0, "utf8");
  const formatOpts = loadFormatOptions(process.cwd());
  const result = formatSource(source, {
    ...formatOpts,
    fileName: "<stdin>",
  });
  if (!result.success || result.code === null) {
    const formatted = formatDiagnostics(result.diagnostics, "<stdin>");
    if (formatted) {
      console.error(formatted);
    } else {
      console.error("error: failed to parse stdin");
    }
    return 1;
  }

  if (options.check) {
    if (result.code !== source) {
      console.error("would reformat <stdin>");
      return 1;
    }
    console.log("1 file(s) already formatted");
    return 0;
  }

  process.stdout.write(result.code);
  return 0;
}

function collectFiles(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    const manifest = findProjectManifest();
    if (manifest) {
      const project = loadProject();
      return collectSnFiles(project.root).sort();
    }
    return collectSnFiles(process.cwd()).sort();
  }

  const out: string[] = [];
  for (const p of paths) {
    if (hasGlobMeta(p)) {
      out.push(...expandGlob(p));
      continue;
    }

    const absolute = resolve(p);
    if (!existsSync(absolute)) {
      console.error(`error: path not found: ${p}`);
      continue;
    }
    const st = statSync(absolute);
    if (st.isDirectory()) {
      out.push(...collectSnFiles(absolute));
    } else if (absolute.toLowerCase().endsWith(".sn")) {
      out.push(absolute);
    } else {
      console.error(`error: not a .sn file: ${p}`);
    }
  }
  return [...new Set(out)].sort();
}

function hasGlobMeta(path: string): boolean {
  return /[*?[\]]/.test(path);
}

// Expand simple globs (e.g. src/**/*.sn) without an external dependency.
function expandGlob(pattern: string): string[] {
  const cwd = process.cwd();
  // Collect all .sn files under cwd (or under the non-glob prefix) and filter.
  const star = pattern.indexOf("*");
  const prefix = star >= 0 ? pattern.slice(0, star).replace(/\/$/, "") : ".";
  const root = resolve(cwd, prefix || ".");
  const searchRoot = existsSync(root) && statSync(root).isDirectory()
    ? root
    : cwd;
  const all = collectSnFiles(searchRoot);
  const regex = globToRegExp(pattern);
  return all.filter((file) => {
    const rel = relative(cwd, file).split(sep).join("/");
    return regex.test(rel) || regex.test(file.split(sep).join("/"));
  });
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    if ("\\.^$+{}()|[]".includes(ch)) {
      re += `\\${ch}`;
      continue;
    }
    re += ch;
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".sn", "target"]);

function collectSnFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.toLowerCase().endsWith(".sn")) {
      out.push(full);
    }
  }
}

/**
 * Collect `.sn` files changed in the Git working tree (staged, unstaged, untracked).
 * Respects `.gitignore` via `git status`. Returns null on Git errors.
 */
function collectChangedSnFiles(): string[] | null {
  const rootProbe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (rootProbe.error) {
    console.error(
      `error: git is required for --changed (${rootProbe.error.message})`,
    );
    return null;
  }
  if (rootProbe.status !== 0) {
    const err = (rootProbe.stderr || rootProbe.stdout || "").trim();
    console.error(
      `error: not a git repository${err ? `: ${err}` : " (git rev-parse failed)"}`,
    );
    return null;
  }
  const gitRoot = rootProbe.stdout.trim();

  const status = spawnSync(
    "git",
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    { encoding: "utf8", cwd: gitRoot },
  );
  if (status.status !== 0) {
    console.error(
      `error: git status failed${status.stderr ? `: ${status.stderr.trim()}` : ""}`,
    );
    return null;
  }

  const projectSn = new Set(collectSnFiles(process.cwd()));
  const out: string[] = [];
  const entries = status.stdout.split("\0").filter((e) => e.length > 0);
  for (const entry of entries) {
    // porcelain -z: XY PATH or XY ORIG\0PATH for renames
    if (entry.length < 4) {
      continue;
    }
    let pathPart = entry.slice(3);
    // Rename/copy records may include " -> "
    const arrow = pathPart.lastIndexOf(" -> ");
    if (arrow >= 0) {
      pathPart = pathPart.slice(arrow + 4);
    }
    if (!pathPart.toLowerCase().endsWith(".sn")) {
      continue;
    }
    const absolute = resolve(gitRoot, pathPart);
    if (projectSn.has(absolute) || absolute.toLowerCase().endsWith(".sn")) {
      // Prefer files under the current walk roots; still allow any .sn in repo.
      if (
        SKIP_DIRS.has(pathPart.split(/[/\\]/)[0] ?? "") ||
        pathPart.split(/[/\\]/).some((p) => SKIP_DIRS.has(p))
      ) {
        continue;
      }
      out.push(absolute);
    }
  }
  return [...new Set(out)].sort();
}
