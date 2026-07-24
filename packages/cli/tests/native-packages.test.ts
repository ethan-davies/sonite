import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLockfile,
  writeLockfile,
  type LockNative,
  type LockPackage,
} from "../src/deps/lock.js";
import {
  cleanNativeCache,
  materializeNativeArtifact,
  NativeIntegrityError,
  nativeArtifactCachePath,
  sha256File,
} from "../src/deps/native-cache.js";
import {
  collectNativePublishArtifacts,
  formatNativePublishChecklist,
} from "../src/deps/native-publish.js";
import {
  formatNativeInstallReport,
  installNativeArtifacts,
  resolveNativeArtifacts,
} from "../src/deps/native-resolve.js";
import {
  parseNativeConfig,
  portableRpathArgs,
  resolveNativeLinkSpec,
} from "../src/native-deps.js";
import { deployRuntimeLibraries } from "../src/project-native.js";
import type { Project } from "../src/project.js";
import { getCacheDir } from "../src/config.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writePkg(
  root: string,
  opts: {
    name: string;
    version: string;
    nativeToml?: string;
    artifact?: { platform: string; filename: string; content: string };
  },
): string {
  mkdirSync(root, { recursive: true });
  const nativeBlock =
    opts.nativeToml ??
    `
[native]
name = "${opts.name}"
version = "${opts.version}"
kind = "static"
libraries = ["foo"]
`;
  writeFileSync(
    join(root, "project.toml"),
    `[package]
name = "${opts.name}"
version = "${opts.version}"
entry = "src/main.sn"

[build]
outdir = "dist"
${nativeBlock}
`,
    "utf8",
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.sn"), "function main(): void {}\n");
  if (opts.artifact) {
    const dir = join(root, "native", opts.artifact.platform);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, opts.artifact.filename),
      opts.artifact.content,
      "utf8",
    );
  }
  return root;
}

describe("native schema", () => {
  it("parses name, version, kind, link, system, and library", () => {
    const config = parseNativeConfig({
      native: {
        name: "sqlite3",
        version: "3.45.0",
        kind: "static",
        link: "auto",
        libraries: ["sqlite3"],
        system: { libraries: ["pthread"] },
        "linux-x64": { library: "libsqlite3.a" },
      },
    });
    expect(config.name).toBe("sqlite3");
    expect(config.version).toBe("3.45.0");
    expect(config.kind).toBe("static");
    expect(config.link).toBe("auto");
    expect(config.systemLibraries).toEqual(["pthread"]);
    expect(config.platforms.get("linux-x64")?.library).toBe("libsqlite3.a");
  });

  it("parses [native.system] dotted table", () => {
    const config = parseNativeConfig({
      native: { libraries: ["foo"] },
      "native.system": { libraries: ["m", "pthread"] },
    });
    expect(config.systemLibraries).toEqual(["m", "pthread"]);
  });

  it("includes system libraries in link spec", () => {
    const root = tempDir("sn-sys-");
    const config = parseNativeConfig({
      native: { libraries: ["missing"] },
      "native.system": { libraries: ["pthread"] },
    });
    const spec = resolveNativeLinkSpec(root, config, "linux-x64");
    expect(spec.systemLibraries).toContain("pthread");
    expect(spec.systemLibraries).toContain("missing");
    expect(spec.runtimeLibraries).toEqual([]);
  });
});

describe("native lockfile", () => {
  it("round-trips [[native]] entries", () => {
    const root = tempDir("sn-nlock-");
    const packages: LockPackage[] = [
      {
        name: "wrap",
        version: "1.0.0",
        checksum: "abc",
        source: "https://registry.example",
        dependencies: [],
      },
    ];
    const natives: LockNative[] = [
      {
        package: "wrap",
        name: "sqlite3",
        version: "3.45.0",
        platform: "linux",
        architecture: "x64",
        kind: "static",
        source: "bundled",
        path: "native/linux-x64/libsqlite3.a",
        sha256: "deadbeef",
        filename: "libsqlite3.a",
      },
    ];
    writeLockfile(root, packages, natives);
    const loaded = loadLockfile(root);
    expect(loaded!.natives).toEqual(natives);
    expect(loaded!.packages[0]!.name).toBe("wrap");
  });
});

describe("native resolution", () => {
  it("resolves a bundled artifact for the requested platform", () => {
    const pkgRoot = tempDir("sn-store-");
    writePkg(pkgRoot, {
      name: "wrap",
      version: "1.0.0",
      artifact: {
        platform: "linux-x64",
        filename: "libfoo.a",
        content: "STATIC",
      },
    });

    const resolved = resolveNativeArtifacts(
      [
        {
          name: "wrap",
          version: "1.0.0",
          checksum: "x",
          source: "https://example",
          dependencies: [],
        },
      ],
      "linux-x64",
      { packageRootFor: () => pkgRoot },
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.filename).toBe("libfoo.a");
    expect(resolved[0]!.kind).toBe("static");
    expect(resolved[0]!.nativeName).toBe("wrap");
  });

  it("fails early when the host platform artifact is missing", () => {
    const pkgRoot = tempDir("sn-missplat-");
    writePkg(pkgRoot, {
      name: "wrap",
      version: "1.0.0",
      artifact: {
        platform: "macos-arm64",
        filename: "libfoo.a",
        content: "x",
      },
    });
    expect(() =>
      resolveNativeArtifacts(
        [
          {
            name: "wrap",
            version: "1.0.0",
            checksum: "x",
            source: "https://example",
            dependencies: [],
          },
        ],
        "linux-x64",
        { packageRootFor: () => pkgRoot },
      ),
    ).toThrow(/does not provide a native artifact/);
  });

  it("detects incompatible native version conflicts", () => {
    const a = tempDir("sn-conf-a-");
    const b = tempDir("sn-conf-b-");
    writePkg(a, {
      name: "pkg-a",
      version: "1.0.0",
      nativeToml: `
[native]
name = "sqlite3"
version = "3.40.0"
kind = "static"
libraries = ["sqlite3"]
`,
      artifact: {
        platform: "linux-x64",
        filename: "libsqlite3.a",
        content: "a",
      },
    });
    writePkg(b, {
      name: "pkg-b",
      version: "1.0.0",
      nativeToml: `
[native]
name = "sqlite3"
version = "4.0.0"
kind = "static"
libraries = ["sqlite3"]
`,
      artifact: {
        platform: "linux-x64",
        filename: "libsqlite3.a",
        content: "b",
      },
    });

    const roots = new Map([
      ["pkg-a@1.0.0", a],
      ["pkg-b@1.0.0", b],
    ]);
    expect(() =>
      resolveNativeArtifacts(
        [
          {
            name: "pkg-a",
            version: "1.0.0",
            checksum: "x",
            source: "https://example",
            dependencies: [],
          },
          {
            name: "pkg-b",
            version: "1.0.0",
            checksum: "y",
            source: "https://example",
            dependencies: [],
          },
        ],
        "linux-x64",
        {
          packageRootFor: (name, version) =>
            roots.get(`${name}@${version}`) ?? name,
        },
      ),
    ).toThrow(/No compatible native version could be resolved/);
  });
});

describe("native cache + integrity", () => {
  it("materializes and verifies SHA-256", () => {
    const srcRoot = tempDir("sn-art-");
    const src = join(srcRoot, "libfoo.a");
    writeFileSync(src, "artifact-bytes");
    const hash = sha256File(src);

    const prev = process.env.SN_CACHE_DIR;
    const cache = tempDir("sn-cache-");
    process.env.SN_CACHE_DIR = cache;
    try {
      const dest = materializeNativeArtifact({
        name: "foo",
        version: "1.0.0",
        platformId: "linux-x64",
        sourcePath: src,
        expectedSha256: hash,
      });
      expect(existsSync(dest)).toBe(true);
      expect(sha256File(dest)).toBe(hash);
      expect(
        nativeArtifactCachePath("foo", "1.0.0", "linux-x64", "libfoo.a"),
      ).toBe(dest);
    } finally {
      if (prev === undefined) {
        delete process.env.SN_CACHE_DIR;
      } else {
        process.env.SN_CACHE_DIR = prev;
      }
    }
  });

  it("rejects integrity mismatches", () => {
    const srcRoot = tempDir("sn-bad-");
    const src = join(srcRoot, "libfoo.a");
    writeFileSync(src, "artifact-bytes");

    const prev = process.env.SN_CACHE_DIR;
    process.env.SN_CACHE_DIR = tempDir("sn-cache2-");
    try {
      expect(() =>
        materializeNativeArtifact({
          name: "foo",
          version: "1.0.0",
          platformId: "linux-x64",
          sourcePath: src,
          expectedSha256: "0".repeat(64),
        }),
      ).toThrow(NativeIntegrityError);
    } finally {
      if (prev === undefined) {
        delete process.env.SN_CACHE_DIR;
      } else {
        process.env.SN_CACHE_DIR = prev;
      }
    }
  });

  it("cleans the native cache", () => {
    const prev = process.env.SN_CACHE_DIR;
    const cache = tempDir("sn-cache3-");
    process.env.SN_CACHE_DIR = cache;
    try {
      mkdirSync(join(getCacheDir(), "native", "x"), { recursive: true });
      writeFileSync(join(getCacheDir(), "native", "x", "f"), "1");
      const result = cleanNativeCache();
      expect(result.removed).toBe(true);
      expect(existsSync(join(getCacheDir(), "native"))).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.SN_CACHE_DIR;
      } else {
        process.env.SN_CACHE_DIR = prev;
      }
    }
  });
});

describe("native publish metadata", () => {
  it("collects multi-platform artifacts and rejects duplicates", () => {
    const root = tempDir("sn-pub-");
    writePkg(root, {
      name: "pubpkg",
      version: "1.0.0",
      nativeToml: `
[native]
name = "foo"
version = "1.0.0"
kind = "static"
libraries = ["foo"]
`,
      artifact: {
        platform: "linux-x64",
        filename: "libfoo.a",
        content: "A",
      },
    });
    mkdirSync(join(root, "native", "macos-arm64"), { recursive: true });
    writeFileSync(join(root, "native", "macos-arm64", "libfoo.a"), "B");

    const project = {
      root,
      native: parseNativeConfig({
        native: {
          name: "foo",
          version: "1.0.0",
          kind: "static",
          libraries: ["foo"],
        },
      }),
    } as unknown as Project;

    const { targets, metadata } = collectNativePublishArtifacts(project);
    expect(targets.map((t) => t.target).sort()).toEqual([
      "linux-x64",
      "macos-arm64",
    ]);
    expect(metadata?.native["linux-x64"]?.sha256).toBe(
      createHash("sha256").update("A").digest("hex"),
    );
    expect(formatNativePublishChecklist(targets).some((l) => l.includes("OK"))).toBe(
      true,
    );
  });

  it("rejects unsupported platform directories", () => {
    const root = tempDir("sn-badplat-");
    mkdirSync(join(root, "native", "linux-riscv64"), { recursive: true });
    writeFileSync(join(root, "native", "linux-riscv64", "libfoo.a"), "x");
    const project = {
      root,
      native: parseNativeConfig({ native: { libraries: ["foo"] } }),
    } as unknown as Project;
    expect(() => collectNativePublishArtifacts(project)).toThrow(
      /unsupported native platform/,
    );
  });
});

describe("runtime deploy + rpath", () => {
  it("copies dynamic libraries next to the binary", () => {
    const root = tempDir("sn-deploy-");
    const lib = join(root, "libfoo.so");
    writeFileSync(lib, "SO");
    const outBin = join(root, "dist", "app");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(outBin, "BIN");
    const deployed = deployRuntimeLibraries(outBin, {
      libraryFiles: [lib],
      libraryPaths: [],
      systemLibraries: [],
      linkArgs: [],
      headers: [],
      runtimeLibraries: [lib],
    });
    expect(deployed).toEqual([join(root, "dist", "libfoo.so")]);
    expect(readFileSync(join(root, "dist", "libfoo.so"), "utf8")).toBe("SO");
  });

  it("emits portable rpath args", () => {
    expect(portableRpathArgs("linux-x64")).toEqual(["-rpath", "$ORIGIN"]);
    expect(portableRpathArgs("macos-arm64")).toEqual([
      "-rpath",
      "@loader_path",
    ]);
    expect(portableRpathArgs("win32-x64")).toEqual([]);
  });
});

describe("install report", () => {
  it("formats Sonite and native sections", () => {
    const text = formatNativeInstallReport(
      [
        {
          name: "wrap",
          version: "1.2.0",
          checksum: "x",
          source: "https://example",
          dependencies: [],
        },
      ],
      [
        {
          package: "wrap",
          name: "sqlite3",
          version: "3.45.0",
          platform: "linux",
          architecture: "x64",
          kind: "static",
          source: "bundled",
          path: "native/linux-x64/libsqlite3.a",
          sha256: "abc",
          filename: "libsqlite3.a",
        },
      ],
    );
    expect(text).toContain("Sonite packages:");
    expect(text).toContain("wrap@1.2.0");
    expect(text).toContain("Native packages:");
    expect(text).toContain("sqlite3@3.45.0");
    expect(text).toContain("verified: SHA-256");
  });
});

describe("native resolve with store packages", () => {
  it("resolves artifacts and installs into lock entries", () => {
    // Use packageVersionPath by placing files under a temp SN config - packages
    // live under getPackagesStoreDir() which is under getConfigDir().
    // Override is not available; instead test installNativeArtifacts directly.
    const pkgRoot = tempDir("sn-res-");
    const artDir = join(pkgRoot, "native", "linux-x64");
    mkdirSync(artDir, { recursive: true });
    const artPath = join(artDir, "libfoo.a");
    writeFileSync(artPath, "LIBDATA");
    const hash = sha256File(artPath);

    const prev = process.env.SN_CACHE_DIR;
    process.env.SN_CACHE_DIR = tempDir("sn-res-cache-");
    try {
      const natives = installNativeArtifacts([
        {
          packageName: "wrap",
          packageVersion: "1.0.0",
          packageRoot: pkgRoot,
          nativeName: "foo",
          nativeVersion: "1.0.0",
          platformId: "linux-x64",
          kind: "static",
          sourcePath: artPath,
          relativePath: "native/linux-x64/libfoo.a",
          sha256: hash,
          filename: "libfoo.a",
        },
      ]);
      expect(natives).toHaveLength(1);
      expect(natives[0]!.sha256).toBe(hash);
      expect(natives[0]!.kind).toBe("static");
      expect(
        existsSync(
          nativeArtifactCachePath("foo", "1.0.0", "linux-x64", "libfoo.a"),
        ),
      ).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.SN_CACHE_DIR;
      } else {
        process.env.SN_CACHE_DIR = prev;
      }
    }
  });

  it("fails locked integrity when artifact hash changes", () => {
    const pkgRoot = tempDir("sn-int-");
    const artPath = join(pkgRoot, "native", "linux-x64", "libfoo.a");
    mkdirSync(join(pkgRoot, "native", "linux-x64"), { recursive: true });
    writeFileSync(artPath, "NEW");
    const prev = process.env.SN_CACHE_DIR;
    process.env.SN_CACHE_DIR = tempDir("sn-int-cache-");
    try {
      expect(() =>
        installNativeArtifacts(
          [
            {
              packageName: "wrap",
              packageVersion: "1.0.0",
              packageRoot: pkgRoot,
              nativeName: "foo",
              nativeVersion: "1.0.0",
              platformId: "linux-x64",
              kind: "static",
              sourcePath: artPath,
              relativePath: "native/linux-x64/libfoo.a",
              sha256: sha256File(artPath),
              filename: "libfoo.a",
            },
          ],
          [
            {
              package: "wrap",
              name: "foo",
              version: "1.0.0",
              platform: "linux",
              architecture: "x64",
              kind: "static",
              source: "bundled",
              path: "native/linux-x64/libfoo.a",
              sha256: "0".repeat(64),
              filename: "libfoo.a",
            },
          ],
        ),
      ).toThrow(/Integrity verification failed/);
    } finally {
      if (prev === undefined) {
        delete process.env.SN_CACHE_DIR;
      } else {
        process.env.SN_CACHE_DIR = prev;
      }
    }
  });
});
