/**
 * win32-arm64 native toolchain is deferred for this milestone.
 */
export function getAddonPath() {
  throw notAvailable();
}

export function getLibDir() {
  throw notAvailable();
}

export function loadBinding() {
  throw notAvailable();
}

function notAvailable() {
  return new Error(
    [
      "Sonite does not currently provide a native LLVM toolchain",
      "for win32-arm64.",
      "",
      "Supported platforms:",
      "- linux-x64",
      "- linux-arm64",
      "- macos-x64",
      "- macos-arm64",
      "- win32-x64",
    ].join("\n"),
  );
}
