#!/usr/bin/env node
/**
 * Prefer a platform optional package, then a local prebuild, else build from the pinned SDK.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function hostPlatformId() {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "win32" && arch === "arm64") return "win32-arm64";
  return `${platform}-${arch}`;
}

const id = hostPlatformId();
const platformAddon = join(root, "..", `llvm-${id}`, "native", "sonite_llvm.node");
const prebuilt = join(
  root,
  "prebuilds",
  `sonite_llvm-${process.platform}-${process.arch}.node`,
);

if (existsSync(platformAddon) || existsSync(prebuilt)) {
  process.exit(0);
}

if (process.env.SONITE_SKIP_NATIVE_BUILD === "1") {
  console.warn(
    "warning: @sonite/llvm native addon missing; SONITE_SKIP_NATIVE_BUILD=1 set",
  );
  process.exit(0);
}

if (id === "win32-arm64") {
  console.warn("warning: win32-arm64 native toolchain is deferred");
  process.exit(0);
}

const build = spawnSync(process.execPath, [join(root, "scripts/build-native.js")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(build.status ?? 1);
