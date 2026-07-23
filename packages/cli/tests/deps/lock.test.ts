import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegistryUrl } from "../../src/config.js";
import {
  loadLockfile,
  writeLockfile,
  type LockPackage,
} from "../../src/deps/lock.js";

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
  });
});
