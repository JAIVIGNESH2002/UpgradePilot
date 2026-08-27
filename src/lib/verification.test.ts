import { describe, expect, it } from "vitest";

import {
  classifyBaselineStatus,
  discoverVerificationPlan,
  listMissingVerificationScripts
} from "@/lib/verification";

const passingInstall = {
  command: "npm ci",
  exitCode: 0,
  durationMs: 10,
  output: "installed"
};

describe("verification planning", () => {
  it("discovers supported scripts in deterministic order", () => {
    expect(
      discoverVerificationPlan({
        build: "next build",
        lint: "eslint .",
        test: "vitest run",
        custom: "echo custom"
      })
    ).toEqual([
      { scriptName: "lint", command: "npm run lint" },
      { scriptName: "test", command: "npm run test" },
      { scriptName: "build", command: "npm run build" }
    ]);
  });

  it("reports missing verification scripts", () => {
    expect(listMissingVerificationScripts({ test: "vitest run" })).toEqual([
      "format:check",
      "lint",
      "typecheck",
      "build"
    ]);
  });
});

describe("classifyBaselineStatus", () => {
  it("fails when install fails", () => {
    expect(
      classifyBaselineStatus({
        install: { ...passingInstall, exitCode: 1 },
        verification: []
      })
    ).toBe("FAILED");
  });

  it("fails when any verification command fails", () => {
    expect(
      classifyBaselineStatus({
        install: passingInstall,
        verification: [
          { command: "npm run test", exitCode: 0, durationMs: 10, output: "ok" },
          { command: "npm run build", exitCode: 1, durationMs: 10, output: "failed" }
        ]
      })
    ).toBe("FAILED");
  });

  it("passes when install and every discovered verification command pass", () => {
    expect(
      classifyBaselineStatus({
        install: passingInstall,
        verification: [{ command: "npm run test", exitCode: 0, durationMs: 10, output: "ok" }]
      })
    ).toBe("PASSED");
  });
});
