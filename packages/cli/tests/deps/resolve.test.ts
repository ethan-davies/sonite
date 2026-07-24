import { describe, expect, it } from "vitest";
import { parseVersionRequirement } from "../../src/deps/semver.js";
import {
  findDependencyCycle,
  formatConflict,
  formatOverrideConflict,
  pickVersion,
} from "../../src/deps/resolve.js";

describe("pickVersion", () => {
  const matching = ["1.3.0", "1.2.0", "1.0.0"];

  it("picks highest when no prefer map", () => {
    expect(pickVersion("http", matching, undefined, new Set())).toBe("1.3.0");
  });

  it("keeps preferred version when still matching and not floating", () => {
    const prefer = new Map([["http", "1.2.0"], ["json", "2.0.0"]]);
    expect(pickVersion("http", matching, prefer, new Set())).toBe("1.2.0");
  });

  it("floats named packages to highest even when preferred", () => {
    const prefer = new Map([["http", "1.2.0"]]);
    expect(pickVersion("http", matching, prefer, new Set(["http"]))).toBe(
      "1.3.0",
    );
  });

  it("falls back to highest when preferred is not in matching", () => {
    const prefer = new Map([["http", "1.1.0"]]);
    expect(pickVersion("http", matching, prefer, new Set())).toBe("1.3.0");
  });
});

describe("findDependencyCycle", () => {
  it("returns null when the graph is acyclic", () => {
    const selected = new Map([
      ["http", { dependencies: { url: { kind: "version" as const, range: "^1.0.0" } } }],
      ["url", { dependencies: {} }],
    ]);
    expect(findDependencyCycle(selected)).toBeNull();
  });

  it("returns a cycle path when packages depend on each other", () => {
    const selected = new Map([
      ["a", { dependencies: { b: { kind: "version" as const, range: "^1.0.0" } } }],
      ["b", { dependencies: { a: { kind: "version" as const, range: "^1.0.0" } } }],
    ]);
    const cycle = findDependencyCycle(selected);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    expect(cycle!.join(" -> ")).toMatch(/a -> b -> a|b -> a -> b/);
  });

  it("formats like the non-convergence diagnostic", () => {
    const selected = new Map([
      ["a", { dependencies: { b: { kind: "version" as const, range: "^1.0.0" } } }],
      ["b", { dependencies: { a: { kind: "version" as const, range: "^1.0.0" } } }],
    ]);
    const cycle = findDependencyCycle(selected)!;
    const message = `dependency resolution did not converge\ncycle: ${cycle.join(" -> ")}`;
    expect(message).toContain("cycle:");
    expect(message).toContain("->");
  });
});

describe("formatConflict", () => {
  it("lists each requirer and the missing package", () => {
    const message = formatConflict("url", [
      {
        range: parseVersionRequirement("^1.5.0"),
        requiredBy: "http",
        requiredByVersion: "1.3.0",
      },
      {
        range: parseVersionRequirement("^1.7.0"),
        requiredBy: "json",
        requiredByVersion: "2.1.0",
      },
    ]);
    expect(message).toContain("Could not resolve dependencies.");
    expect(message).toContain("http 1.3.0 requires:");
    expect(message).toContain("url ^1.5.0");
    expect(message).toContain("json 2.1.0 requires:");
    expect(message).toContain("No compatible version of url exists.");
  });
});

describe("formatOverrideConflict", () => {
  it("describes an incompatible override", () => {
    const message = formatOverrideConflict("bar", "2.0.0", {
      range: parseVersionRequirement("^1.0.0"),
      requiredBy: "foo",
      requiredByVersion: "1.0.0",
    });
    expect(message).toContain("Dependency override conflict:");
    expect(message).toContain("Package: bar");
    expect(message).toContain("Requested override: 2.0.0");
    expect(message).toContain("foo requires: ^1.0.0");
    expect(message).toContain(
      "The override is incompatible with the dependency constraints.",
    );
  });
});
