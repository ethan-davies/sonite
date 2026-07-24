#!/usr/bin/env node
/**
 * Validate that sonite_llvm.node does not depend on system LLVM/LLD.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const LLVM_NAME = /libLLVM|liblld|LLVM\.dll|lld.*\.dll/i;

/**
 * @param {string} nodePath path to sonite_llvm.node
 * @param {string} libDir package lib/ directory containing bundled LLVM
 */
export function validateNativeDeps(nodePath, libDir) {
  if (!existsSync(nodePath)) {
    throw new Error(`native addon not found: ${nodePath}`);
  }
  const libRoot = resolve(libDir);
  const platform = process.platform;

  if (platform === "linux") {
    const r = spawnSync("ldd", [nodePath], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`ldd failed: ${r.stderr || r.stdout}`);
    }
    const problems = [];
    for (const line of (r.stdout || "").split("\n")) {
      const m = line.match(/^\s*(\S+)\s+=>\s+(\S+)/);
      if (!m) continue;
      const name = m[1];
      const path = m[2];
      if (!LLVM_NAME.test(name) && !LLVM_NAME.test(path)) continue;
      if (path === "not" || line.includes("not found")) {
        problems.push(`unresolved: ${line.trim()}`);
        continue;
      }
      try {
        const real = realpathSync(path);
        if (!real.startsWith(libRoot + "/") && real !== joinPath(libRoot, "")) {
          // Allow if realpath is under libRoot
          const under = real === libRoot || real.startsWith(libRoot + "/");
          if (!under) {
            problems.push(`system LLVM/LLD dependency: ${name} => ${real}`);
          }
        }
      } catch {
        problems.push(`could not resolve: ${line.trim()}`);
      }
    }
    if (problems.length) {
      throw new Error(
        `native dependency validation failed:\n${problems.join("\n")}`,
      );
    }
    return;
  }

  if (platform === "darwin") {
    const r = spawnSync("otool", ["-L", nodePath], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`otool failed: ${r.stderr || r.stdout}`);
    }
    const problems = [];
    for (const line of (r.stdout || "").split("\n").slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const path = trimmed.split(/\s+/)[0];
      if (!LLVM_NAME.test(path)) continue;
      if (path.startsWith("@loader_path/") || path.startsWith("@rpath/")) {
        continue;
      }
      problems.push(`unexpected LLVM/LLD dependency: ${path}`);
    }
    if (problems.length) {
      throw new Error(
        `native dependency validation failed:\n${problems.join("\n")}`,
      );
    }
    return;
  }

  if (platform === "win32") {
    const files = readdirSync(libDir);
    const hasLlvm = files.some((f) => /LLVM/i.test(f));
    if (!hasLlvm) {
      throw new Error(`Windows package lib/ missing LLVM DLLs in ${libDir}`);
    }
    return;
  }

  console.warn(`warning: dependency validation skipped on ${platform}`);
}

function joinPath(a, _b) {
  return a;
}

if (process.argv[1] && process.argv[1].includes("validate-native-deps")) {
  const nodePath = process.argv[2];
  const libDir = process.argv[3];
  if (!nodePath || !libDir) {
    console.error("usage: validate-native-deps.js <addon.node> <libDir>");
    process.exit(1);
  }
  try {
    validateNativeDeps(nodePath, libDir);
    console.log("ok: native dependencies validated");
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
