import { describe, expect, it } from "vitest";

import { runBaselineVerification, type SandboxProvider } from "@/lib/baseline";
import type { CommandResult } from "@/lib/verification";

function fakeSandbox(results: Record<string, CommandResult>): SandboxProvider {
  return {
    async createWorkspace() {
      return {
        async run(command) {
          const result = results[command];

          if (result === undefined) {
            throw new Error(`Unexpected command: ${command}`);
          }

          return result;
        }
      };
    }
  };
}

function result(command: string, exitCode: number): CommandResult {
  return {
    command,
    exitCode,
    durationMs: 12,
    output: exitCode === 0 ? "ok" : "failed"
  };
}

describe("runBaselineVerification", () => {
  it("stops after an install failure", async () => {
    await expect(
      runBaselineVerification({
        repositoryUrl: "https://github.com/acme/failing",
        scripts: { test: "vitest run" },
        sandboxProvider: fakeSandbox({
          "npm ci": result("npm ci", 1)
        })
      })
    ).resolves.toMatchObject({
      status: "FAILED",
      install: { exitCode: 1 },
      verification: []
    });
  });

  it("runs available verification scripts after install", async () => {
    const baseline = await runBaselineVerification({
      repositoryUrl: "https://github.com/acme/passing",
      scripts: {
        lint: "eslint .",
        test: "vitest run"
      },
      sandboxProvider: fakeSandbox({
        "npm ci": result("npm ci", 0),
        "npm run lint": result("npm run lint", 0),
        "npm run test": result("npm run test", 0)
      })
    });

    expect(baseline.status).toBe("PASSED");
    expect(baseline.verification.map((item) => item.command)).toEqual([
      "npm run lint",
      "npm run test"
    ]);
  });

  it("classifies verification failures as failed baselines", async () => {
    const baseline = await runBaselineVerification({
      repositoryUrl: "https://github.com/acme/failing-tests",
      scripts: {
        test: "vitest run",
        build: "next build"
      },
      sandboxProvider: fakeSandbox({
        "npm ci": result("npm ci", 0),
        "npm run test": result("npm run test", 1),
        "npm run build": result("npm run build", 0)
      })
    });

    expect(baseline.status).toBe("FAILED");
    expect(baseline.verification).toHaveLength(2);
  });
});
