import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegistryUrl } from "../../src/config.js";
import {
  loadLockfile,
  writeLockfile,
  type LockPackage,
} from "../../src/deps/lock.js";
import { loadProjectFromManifest } from "../../src/project.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "sn-lock-"));
  tempRoots.push(root);
  return root;
}

describe("project.lock", () => {
  it("round-trips packages including source", () => {
    const root = tempProject();
    const packages: LockPackage[] = [
      {
        name: "http",
        version: "1.3.0",
        checksum: "abc123",
        source: "https://registry.example",
        dependencies: ["url"],
      },
      {
        name: "url",
        version: "1.7.2",
        checksum: "def456",
        source: "https://registry.example",
        dependencies: [],
      },
    ];
    writeLockfile(root, packages);
    const loaded = loadLockfile(root);
    expect(loaded).not.toBeNull();
    expect(loaded!.packages).toEqual([
      {
        name: "http",
        version: "1.3.0",
        checksum: "abc123",
        source: "https://registry.example",
        dependencies: ["url"],
      },
      {
        name: "url",
        version: "1.7.2",
        checksum: "def456",
        source: "https://registry.example",
        dependencies: [],
      },
    ]);
  });

  it("round-trips override, dev, and provenance fields", () => {
    const root = tempProject();
    writeLockfile(root, [
      {
        name: "bar",
        version: "2.0.0",
        checksum: "abc",
        source: "https://registry.example",
        dependencies: [],
        override: true,
        publishedBy: "alice",
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "test-utils",
        version: "1.0.0",
        checksum: "def",
        source: "https://registry.example",
        dependencies: [],
        dev: true,
      },
    ]);
    const loaded = loadLockfile(root)!;
    expect(loaded.packages[0]).toMatchObject({
      name: "bar",
      override: true,
      publishedBy: "alice",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(loaded.packages[1]).toMatchObject({
      name: "test-utils",
      dev: true,
    });
  });

  it("round-trips path dependency sources", () => {
    const root = tempProject();
    writeLockfile(root, [
      {
        name: "my-lib",
        version: "0.1.0",
        checksum: "pathhash",
        source: "path:/tmp/my-lib",
        dependencies: [],
      },
    ]);
    expect(loadLockfile(root)!.packages[0]!.source).toBe("path:/tmp/my-lib");
  });

  it("defaults missing source to the active registry URL", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "project.lock"),
      `# generated
[[package]]
name = "json"
version = "2.1.0"
checksum = "deadbeef"
dependencies = []
`,
      "utf8",
    );
    const loaded = loadLockfile(root);
    expect(loaded!.packages[0]!.source).toBe(getRegistryUrl());
    expect(loaded!.natives).toEqual([]);
  });
});

describe("project.toml dependency extras", () => {
  it("parses overrides, path deps, and dev-dependencies", () => {
    const root = tempProject();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "project.toml"),
      `[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"

[dependencies]
foo = "^1.0.0"
local = { path = "../local" }

[dev-dependencies]
test-utils = "1.0.0"

[overrides]
bar = "2.0.0"
`,
      "utf8",
    );
    const project = loadProjectFromManifest(join(root, "project.toml"));
    expect(project.dependencies.foo).toEqual({
      kind: "version",
      range: "^1.0.0",
    });
    expect(project.dependencies.local).toEqual({
      kind: "path",
      path: "../local",
    });
    expect(project.devDependencies["test-utils"]).toEqual({
      kind: "version",
      range: "1.0.0",
    });
    expect(project.overrides.bar).toBe("2.0.0");
  });

  it("rejects incompatible override forms and git deps", () => {
    const root = tempProject();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "project.toml"),
      `[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"

[overrides]
bar = "^2.0.0"
`,
      "utf8",
    );
    expect(() =>
      loadProjectFromManifest(join(root, "project.toml")),
    ).toThrow(/exact version/);

    writeFileSync(
      join(root, "project.toml"),
      `[package]
name = "app"
version = "0.1.0"
entry = "src/main.sn"

[dependencies]
x = { git = "https://example.com/x.git" }
`,
      "utf8",
    );
    expect(() =>
      loadProjectFromManifest(join(root, "project.toml")),
    ).toThrow(/git dependencies are not supported/);
  });
});
