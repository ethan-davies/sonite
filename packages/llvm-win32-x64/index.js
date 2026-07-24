import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Ensure bundled DLLs are discoverable before loading the addon.
 * Uses PATH prefix for the package lib/ directory (no user configuration).
 */
function prependDllDir() {
  const lib = join(root, "lib");
  const native = join(root, "native");
  const sep = ";";
  const prev = process.env.PATH || "";
  process.env.PATH = `${lib}${sep}${native}${sep}${prev}`;
}

export function getAddonPath() {
  const path = join(root, "native", "sonite_llvm.node");
  if (!existsSync(path)) {
    throw new Error(
      `@sonite/llvm-win32-x64 native addon missing at ${path}. Run pnpm build:native.`,
    );
  }
  return path;
}

export function getLibDir() {
  return join(root, "lib");
}

export function loadBinding() {
  prependDllDir();
  return require(getAddonPath());
}
