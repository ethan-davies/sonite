#!/usr/bin/env node
/**
 * Build sonite_llvm.node against the pinned LLVM SDK (downloaded or SONITE_LLVM_SDK),
 * bundle required shared libraries, install into the host platform package, and validate deps.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureLlvmSdk, hostPlatformId } from "./fetch-llvm-sdk.js";
import { validateNativeDeps } from "./validate-native-deps.js";

const require = createRequire(import.meta.url);
const meta = require("./llvm-version.json");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = meta.version;
const workspaceRoot = join(root, "..", "..");

function majorMinor(v) {
  const parts = String(v).split(".");
  return `${parts[0]}.${parts[1]}`;
}

function sdkLlvmConfig(sdkRoot) {
  const name =
    process.platform === "win32" ? "llvm-config.exe" : "llvm-config";
  return join(sdkRoot, "bin", name);
}

function runLlvmConfig(sdkRoot, args) {
  const bin = sdkLlvmConfig(sdkRoot);
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `llvm-config ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
    );
  }
  return r.stdout.trim();
}

function copySharedLibs(sdkLib, destLib) {
  mkdirSync(destLib, { recursive: true });
  if (!existsSync(sdkLib)) {
    throw new Error(`SDK lib dir missing: ${sdkLib}`);
  }

  const wanted = (name) =>
    /^(libLLVM|liblld)/.test(name) &&
    (name.includes(".so") || name.endsWith(".dylib") || name.endsWith(".dll"));

  let copied = 0;
  for (const entry of readdirSync(sdkLib)) {
    if (!wanted(entry)) continue;
    const src = join(sdkLib, entry);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    // Always materialize real files (no absolute symlinks into /usr).
    if (st.isSymbolicLink() || st.isFile()) {
      const dest = join(destLib, entry);
      try {
        cpSync(src, dest, { dereference: true });
        copied += 1;
      } catch (err) {
        // Skip broken symlinks / static-only names
        if (st.isFile()) {
          throw err;
        }
      }
    }
  }
  return copied;
}

function platformPackageDir(platformId) {
  // packages/llvm-linux-x64 etc.
  return join(workspaceRoot, "packages", `llvm-${platformId}`);
}

function napiIncludeDir() {
  const r = spawnSync(
    process.execPath,
    ["-p", "require('node-addon-api').include"],
    { cwd: root, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error("node-addon-api not installed in @sonite/llvm");
  }
  return r.stdout.trim().replace(/^"|"$/g, "");
}

function nodeIncludeDir() {
  if (existsSync("/usr/include/node")) return "/usr/include/node";
  // node-gyp headers cache
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(home, ".cache/node-gyp"),
    join(home, "AppData/Local/node-gyp/Cache"),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    for (const ver of readdirSync(base)) {
      const inc = join(base, ver, "include", "node");
      if (existsSync(join(inc, "node_api.h"))) return inc;
    }
  }
  throw new Error(
    "Node headers not found (expected /usr/include/node or node-gyp cache)",
  );
}

async function main() {
  const platformId = process.env.SONITE_TARGET_PLATFORM || hostPlatformId();
  if (meta.deferredPlatforms?.includes(platformId)) {
    console.error(
      `error: platform ${platformId} is deferred; no native artifact in this milestone`,
    );
    process.exit(1);
  }

  console.error(`info: ensuring LLVM ${pinned} SDK for ${platformId}…`);
  let sdkRoot;
  if (process.env.SONITE_BUNDLE_FROM_SYSTEM === "1") {
    console.error(
      "warning: SONITE_BUNDLE_FROM_SYSTEM=1 — building against system LLVM and bundling its libs",
    );
    const cfg = spawnSync("llvm-config", ["--prefix"], { encoding: "utf8" });
    if (cfg.status !== 0) {
      throw new Error("system llvm-config not found");
    }
    sdkRoot = cfg.stdout.trim();
  } else {
    try {
      sdkRoot = await ensureLlvmSdk(platformId);
    } catch (err) {
      throw err;
    }
  }
  const sdkConfig = sdkLlvmConfig(sdkRoot);
  if (!existsSync(sdkConfig)) {
    // Some layouts only have headers/libs; try system llvm-config only for version check via header
    console.error(
      `warning: ${sdkConfig} missing; using include/lib from SDK with compiler defaults`,
    );
  }

  let sdkVersion = pinned;
  if (existsSync(sdkConfig)) {
    sdkVersion = runLlvmConfig(sdkRoot, ["--version"]);
    if (majorMinor(sdkVersion) !== majorMinor(pinned)) {
      console.error(
        `error: incompatible LLVM SDK version: found ${sdkVersion}, Sonite requires ${pinned}`,
      );
      process.exit(1);
    }
  }

  const llvmInclude = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--includedir"])
    : join(sdkRoot, "include");
  const llvmLibDir = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--libdir"])
    : join(sdkRoot, "lib");
  const llvmLdflags = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--ldflags"])
    : `-L${llvmLibDir}`;
  const llvmLibs = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--libs"])
    : "-lLLVM";
  const llvmSys = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--system-libs"])
    : "";
  const llvmCxx = existsSync(sdkConfig)
    ? runLlvmConfig(sdkRoot, ["--cxxflags"])
        .split(/\s+/)
        .filter((f) => f && f !== "-fno-exceptions" && f !== "-fno-rtti")
        .join(" ")
    : `-I${llvmInclude} -std=c++17`;

  const buildDir = join(root, "build", "Release");
  mkdirSync(buildDir, { recursive: true });
  const out = join(buildDir, "sonite_llvm.node");
  const sources = ["native/addon.cpp", "native/backend.cpp", "native/linker.cpp"]
    .map((s) => join(root, s))
    .join(" ");

  const napiDir = napiIncludeDir();
  const nodeInc = nodeIncludeDir();
  const cxx = process.env.CXX || "c++";

  // Bundle libs into platform package lib/ with rpath relative to .node in native/
  const pkgDir = platformPackageDir(platformId);
  const pkgNative = join(pkgDir, "native");
  const pkgLib = join(pkgDir, "lib");
  mkdirSync(pkgNative, { recursive: true });
  mkdirSync(pkgLib, { recursive: true });

  const rpathFlag =
    process.platform === "darwin"
      ? "-Wl,-rpath,@loader_path/../lib"
      : "-Wl,-rpath,$ORIGIN/../lib";

  const lldLibs = ["-llldELF", "-llldMachO", "-llldCOFF", "-llldCommon", "-lLLVM"];

  const compileArgs = [
    "-shared",
    "-fPIC",
    "-std=c++17",
    "-fexceptions",
    "-frtti",
    "-O2",
    `-I${napiDir}`,
    `-I${nodeInc}`,
    `-I${llvmInclude}`,
    `-DSONITE_LLVM_VERSION_EXPECTED="${pinned}"`,
    "-DNAPI_DISABLE_CPP_EXCEPTIONS",
    "-DNODE_ADDON_API_DISABLE_DEPRECATED",
    ...llvmCxx.split(/\s+/).filter(Boolean),
    ...["native/addon.cpp", "native/backend.cpp", "native/linker.cpp"].map((s) =>
      join(root, s),
    ),
    `-o${out}`,
    ...llvmLdflags.split(/\s+/).filter(Boolean),
    `-L${llvmLibDir}`,
    ...lldLibs,
    ...llvmLibs.split(/\s+/).filter(Boolean),
    ...llvmSys.split(/\s+/).filter(Boolean),
    rpathFlag,
  ];

  console.error("info: compiling native addon against pinned SDK…");
  const compile = spawnSync(cxx, compileArgs, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (compile.status !== 0) {
    if (compile.stdout) process.stdout.write(compile.stdout);
    if (compile.stderr) process.stderr.write(compile.stderr);
    process.exit(compile.status ?? 1);
  }

  // Copy shared LLVM/LLD libraries into package lib/
  rmSync(pkgLib, { recursive: true, force: true });
  mkdirSync(pkgLib, { recursive: true });
  let n = copySharedLibs(llvmLibDir, pkgLib);
  if (n === 0) {
    const lib64 = join(sdkRoot, "lib64");
    if (existsSync(lib64)) {
      n = copySharedLibs(lib64, pkgLib);
    }
  }
  const bundled = readdirSync(pkgLib);
  if (bundled.length === 0) {
    console.error(
      `error: no LLVM/LLD shared libraries found in ${llvmLibDir} to bundle`,
    );
    process.exit(1);
  }
  console.error(`info: bundled ${bundled.length} library files into ${pkgLib}`);

  copyFileSync(out, join(pkgNative, "sonite_llvm.node"));
  // Dev fallback prebuild
  const prebuilds = join(root, "prebuilds");
  mkdirSync(prebuilds, { recursive: true });
  copyFileSync(out, join(prebuilds, `sonite_llvm-${process.platform}-${process.arch}.node`));

  // Also place a copy of libs under prebuilds/lib for local loadNative fallback
  const preLib = join(prebuilds, "lib");
  rmSync(preLib, { recursive: true, force: true });
  cpSync(pkgLib, preLib, { recursive: true });

  writeFileSync(
    join(pkgDir, "BUILD_INFO.json"),
    JSON.stringify(
      { platformId, llvm: sdkVersion, pinned, sdkRoot },
      null,
      2,
    ) + "\n",
  );

  try {
    validateNativeDeps(join(pkgNative, "sonite_llvm.node"), pkgLib);
    console.error("info: native dependency validation passed");
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`built ${join(pkgNative, "sonite_llvm.node")}`);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
