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
    vi.useRealTimers();
  });

  it("returns pollable running snapshots one active step at a time", async () => {
    const runVerification = vi.fn(
      () =>
        new Promise<never>(() => {
          // Keep the run open so polling snapshots can advance.
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
    expect(getBaselineRun(started.id)?.baseline.steps[2]).toMatchObject({
      name: "Lint",
      status: "running"
    });
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
});

function makeRepositoryInspection(): RepositoryInspection {
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
        name: "npm",
        declared: "npm@10.0.0",
        lockfile: { type: "npm", path: "package-lock.json", version: 3 },
        support: "supported",
        installCommand: "npm ci"
      },
      hasPackageLock: true,
      lockfileVersion: 3,
      dependencies: [],
      scripts: { lint: "eslint ." }
    }
  };
}
