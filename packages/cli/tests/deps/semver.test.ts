import { describe, expect, it } from "vitest";
import {
  caretOf,
  maxSatisfying,
  parseVersionRequirement,
  versionSatisfies,
  versionsMatchingAll,
} from "../../src/deps/semver.js";
import { ProjectError } from "../../src/project.js";

describe("parseVersionRequirement", () => {
  it("parses exact, caret, and tilde", () => {
    expect(parseVersionRequirement("1.2.3")).toMatchObject({
      kind: "exact",
      range: "1.2.3",
    });
    expect(parseVersionRequirement("^1.2.3")).toMatchObject({
      kind: "caret",
      range: "^1.2.3",
    });
    expect(parseVersionRequirement("~1.2.3")).toMatchObject({
      kind: "tilde",
      range: "~1.2.3",
    });
  });

  it("rejects unsupported operators", () => {
    expect(() => parseVersionRequirement(">=1.0.0")).toThrow(ProjectError);
    expect(() => parseVersionRequirement("*")).toThrow(ProjectError);
  });
});

describe("versionSatisfies / maxSatisfying / versionsMatchingAll", () => {
  const versions = ["1.0.0", "1.2.0", "1.2.3", "1.3.0", "2.0.0"];

  it("satisfies caret and tilde ranges", () => {
    expect(versionSatisfies("1.3.0", "^1.2.0")).toBe(true);
    expect(versionSatisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(versionSatisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(versionSatisfies("1.3.0", "~1.2.0")).toBe(false);
  });

  it("picks the highest matching version", () => {
    expect(maxSatisfying(versions, "^1.2.0")).toBe("1.3.0");
    expect(maxSatisfying(versions, "~1.2.0")).toBe("1.2.3");
    expect(maxSatisfying(versions, "1.2.3")).toBe("1.2.3");
  });

  it("intersects multiple requirements", () => {
    expect(versionsMatchingAll(versions, ["^1.0.0", "~1.2.0"])).toEqual([
      "1.2.3",
      "1.2.0",
    ]);
    expect(versionsMatchingAll(versions, ["^1.0.0", "^2.0.0"])).toEqual([]);
  });

  it("builds caret pins from a version", () => {
    expect(caretOf("1.2.3")).toBe("^1.2.3");
  });
});
