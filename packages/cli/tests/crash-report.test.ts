import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InternalError } from "@sonite/compiler";
import { writeCrashReport } from "../src/crash-report.js";

const previousCrashesDir = process.env.SN_CRASHES_DIR;
let tempDir: string | undefined;

afterEach(() => {
  if (previousCrashesDir === undefined) {
    delete process.env.SN_CRASHES_DIR;
  } else {
    process.env.SN_CRASHES_DIR = previousCrashesDir;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("crash reporting", () => {
  it("writes a local ICE report without uploading", () => {
    tempDir = mkdtempSync(join(tmpdir(), "sn-crashes-"));
    process.env.SN_CRASHES_DIR = tempDir;

    const { reportPath, userMessage } = writeCrashReport({
      error: new InternalError("boom in emit", { phase: "codegen" }),
      sourcePath: "/tmp/example.sn",
    });

    const body = readFileSync(reportPath, "utf8");
    expect(body).toContain("Compiler version:");
    expect(body).toContain("Phase: codegen");
    expect(body).toContain("Error: boom in emit");
    expect(body).toContain("Source: /tmp/example.sn");
    expect(body).toContain("was not uploaded");
    expect(userMessage).toContain(reportPath);
    expect(userMessage).toContain("internal error");
  });
});
