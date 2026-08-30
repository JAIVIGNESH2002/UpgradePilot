import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearBaselineRunsForTests,
  getBaselineRun,
  startBaselineRun
} from "@/lib/baseline-run-store";
import type { RepositoryInspection } from "@/lib/package-inspection";
import type { BaselineVerificationResult } from "@/lib/verification";

describe("baseline run store", () => {
  beforeEach(() => {
    clearBaselineRunsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
  });

  afterEach(() => {
    clearBaselineRunsForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps pollable running snapshots on the current backend step", async () => {
    const runVerification = vi.fn(
      () =>
        new Promise<never>(() => {
          // Keep the run open so polling snapshots cannot receive new command evidence.
        })
    );

    const started = await startBaselineRun("https://github.com/acme/widgets", {
      inspectRepository: vi.fn(async () => makeRepositoryInspection()),
      runVerification
    });

    expect(started.status).toBe("running");
    expect(started.baseline.steps[0]).toMatchObject({
      name: "Install dependencies",
      status: "running"
    });
    expect(started.baseline.steps[1]).toMatchObject({ name: "Format check", status: "skipped" });
    expect(started.baseline.steps[2]).toMatchObject({ name: "Lint", status: "pending" });

    vi.setSystemTime(new Date("2026-08-28T10:00:04Z"));
    expect(getBaselineRun(started.id)?.baseline.steps[0]).toMatchObject({
      name: "Install dependencies",
      status: "running",
      output: "Waiting for TrueForge sandbox command output..."
    });
    expect(getBaselineRun(started.id)?.baseline.steps[2]).toMatchObject({ status: "pending" });
  });

  it("replaces planned progress with real command evidence when completed", async () => {
    const started = await startBaselineRun("https://github.com/acme/widgets", {
      inspectRepository: vi.fn(async () => makeRepositoryInspection()),
      runVerification: vi.fn(async (): Promise<BaselineVerificationResult> => ({
        status: "PASSED",
        install: { command: "npm ci", exitCode: 0, durationMs: 10, output: "installed" },
        verification: [{ command: "npm run lint", exitCode: 0, durationMs: 20, output: "ok" }],
        skippedScripts: ["format:check", "typecheck", "test", "build"]
      }))
    });
    await vi.runAllTimersAsync();

    expect(getBaselineRun(started.id)).toMatchObject({
      status: "completed",
      baseline: {
        status: "healthy",
        steps: expect.arrayContaining([
          expect.objectContaining({ command: "npm ci", status: "passed" }),
          expect.objectContaining({ command: "npm run lint", status: "passed" })
        ])
      }
    });
  });

  it("evicts completed baseline runs after the configured retention window", async () => {
    vi.stubEnv("UPGRADEPILOT_RUN_RETENTION_MS", "1000");
    const started = await startBaselineRun("https://github.com/acme/widgets", {
      inspectRepository: vi.fn(async () => makeRepositoryInspection({ packageManager: "yarn" }))
    });

    expect(getBaselineRun(started.id)).not.toBeNull();

    vi.setSystemTime(new Date("2026-08-28T10:00:01.001Z"));

    expect(getBaselineRun(started.id)).toBeNull();
  });

  it("evicts oldest completed baseline runs when the size limit is reached", async () => {
    vi.stubEnv("UPGRADEPILOT_MAX_RUNS", "1");
    const first = await startBaselineRun("https://github.com/acme/first", {
      inspectRepository: vi.fn(async () => makeRepositoryInspection({ packageManager: "yarn" }))
    });

    vi.setSystemTime(new Date("2026-08-28T10:00:01Z"));

    const second = await startBaselineRun("https://github.com/acme/second", {
      inspectRepository: vi.fn(async () => makeRepositoryInspection({ packageManager: "yarn" }))
    });

    expect(getBaselineRun(first.id)).toBeNull();
    expect(getBaselineRun(second.id)).not.toBeNull();
  });
});

function makeRepositoryInspection({
  packageManager = "npm"
}: { packageManager?: "npm" | "yarn" } = {}): RepositoryInspection {
  return {
    metadata: {
      owner: "acme",
      name: "widgets",
      url: "https://github.com/acme/widgets",
      description: "Useful widgets",
      defaultBranch: "main",
      language: "TypeScript",
      updatedAt: "2026-08-27T10:00:00Z"
    },
    package: {
      packageName: "widgets",
      nodeRequirement: ">=22",
      packageManager: {
        name: packageManager,
        declared: `${packageManager}@10.0.0`,
        lockfile:
          packageManager === "npm"
            ? { type: "npm", path: "package-lock.json", version: 3 }
            : { type: "yarn", path: "yarn.lock", version: null },
        support: packageManager === "npm" ? "supported" : "unsupported",
        installCommand: packageManager === "npm" ? "npm ci" : null
      },
      hasPackageLock: true,
      lockfileVersion: 3,
      dependencies: [],
      scripts: { lint: "eslint ." }
    }
  };
}
