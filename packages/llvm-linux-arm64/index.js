import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function getAddonPath() {
  const path = join(root, "native", "sonite_llvm.node");
  if (!existsSync(path)) {
    throw new Error(
      `@sonite/llvm-linux-arm64 native addon missing at ${path}. Run pnpm build:native.`,
    );
  }
  return path;
}

export function getLibDir() {
  return join(root, "lib");
}

export function loadBinding() {
  return require(getAddonPath());
}
