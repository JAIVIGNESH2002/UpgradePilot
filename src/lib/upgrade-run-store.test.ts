import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUpgradeRunsForTests, getUpgradeRun, startUpgradeRun } from "@/lib/upgrade-run-store";
import type { WorkspaceBaseline } from "@/lib/repository-workspace";

describe("upgrade-run-store", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearUpgradeRunsForTests();
  });

  it("blocks upgrade verification when baseline is not healthy", () => {
    const run = startUpgradeRun({
      repositoryUrl: "https://github.com/acme/widgets",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      changeType: "minor",
      baseline: { ...healthyBaseline, status: "failed", message: "npm test failed" },
      packageManager: "npm"
    });

    expect(run.status).toBe("completed");
    expect(run.outcome).toBe("blocked");
    expect(run.steps[0]).toMatchObject({
      name: "Check baseline",
      status: "failed",
      output: "npm test failed"
    });
  });

  it("progresses deterministic upgrade workflow steps without model calls", async () => {
    vi.useFakeTimers();
    let resolveVerification: (value: Awaited<ReturnType<typeof successfulUpgrade>>) => void = () =>
      undefined;
    const runVerification = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof successfulUpgrade>>>((resolve) => {
          resolveVerification = resolve;
        })
    );
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "left-pad",
        currentVersion: "1.3.0",
        targetVersion: "1.3.1",
        changeType: "major",
        baseline: healthyBaseline,
        packageManager: "pnpm"
      },
      { runVerification }
    );

    expect(run.status).toBe("running");
    expect(run.steps[0]?.status).toBe("running");
    expect(run.steps[3]?.command).toBe("pnpm add left-pad@1.3.1");
    expect(runVerification).toHaveBeenCalledWith({
      repositoryUrl: "https://github.com/acme/widgets",
      packageManager: "pnpm",
      packageName: "left-pad",
      targetVersion: "1.3.1"
    });

    await vi.advanceTimersByTimeAsync(2500);
    const progressedRun = getUpgradeRun(run.id);

    expect(progressedRun?.steps[0]?.status).toBe("passed");
    expect(progressedRun?.steps[1]?.status).toBe("running");

    resolveVerification(successfulUpgrade());
    await vi.runAllTimersAsync();
    const completedRun = getUpgradeRun(run.id);

    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.outcome).toBe("verified");
    expect(completedRun?.steps.at(-1)?.status).toBe("skipped");
    expect(completedRun?.message).toContain("Upgrade verified");
  });

  it("hands off to the repair agent when deterministic verification fails", async () => {
    const runRepairHandoff = vi.fn(async () => ({
      status: "completed" as const,
      summary: "Repair agent identified an API compatibility issue.",
      sessionId: "session-1",
      turnId: "turn-1"
    }));
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "react",
        currentVersion: "18.3.1",
        targetVersion: "19.0.0",
        changeType: "major",
        baseline: healthyBaseline,
        packageManager: "npm"
      },
      {
        runVerification: vi.fn(async () => ({
          status: "FAILED" as const,
          commands: [
            command("git clone --depth 1 https://github.com/acme/widgets repo", 0),
            command("npm install react@19.0.0", 0),
            command("npm ci", 0),
            command("npm run test", 1, "test failed")
          ],
          skippedScripts: [],
          modelRepairRequired: true,
          runtimeChangeRequired: false
        })),
        runRepairHandoff
      }
    );
    await vi.waitFor(() => expect(getUpgradeRun(run.id)?.status).toBe("completed"));
    const completedRun = getUpgradeRun(run.id);

    expect(runRepairHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "react",
        currentVersion: "18.3.1",
        targetVersion: "19.0.0"
      })
    );
    expect(completedRun?.outcome).toBe("repair_simulated");
    expect(completedRun?.message).toContain("repair agent handoff completed");
    expect(completedRun?.steps.at(-1)?.status).toBe("passed");
    expect(completedRun?.steps.at(-1)?.output).toContain("API compatibility");
  });

  it("blocks runtime/install incompatibility without model repair", async () => {
    const runRepairHandoff = vi.fn();
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "react",
        currentVersion: "18.3.1",
        targetVersion: "19.0.0",
        changeType: "major",
        baseline: healthyBaseline,
        packageManager: "npm"
      },
      {
        runVerification: vi.fn(async () => ({
          status: "BLOCKED" as const,
          commands: [
            command("git clone --depth 1 https://github.com/acme/widgets repo", 0),
            command("npm install react@19.0.0", 1, "npm error code EBADENGINE")
          ],
          skippedScripts: [],
          modelRepairRequired: false,
          runtimeChangeRequired: true
        })),
        runRepairHandoff
      }
    );
    await vi.waitFor(() => expect(getUpgradeRun(run.id)?.status).toBe("completed"));
    const completedRun = getUpgradeRun(run.id);

    expect(runRepairHandoff).not.toHaveBeenCalled();
    expect(completedRun?.outcome).toBe("blocked");
    expect(completedRun?.message).toContain("runtime");
    expect(completedRun?.steps.at(-1)?.status).toBe("skipped");
  });
});

const healthyBaseline: WorkspaceBaseline = {
  status: "healthy",
  updatedAt: "2026-08-28T10:00:00Z",
  commands: 2,
  message: null,
  steps: [
    {
      name: "Install dependencies",
      command: "npm ci",
      status: "passed",
      durationMs: 1000,
      output: "installed"
    },
    {
      name: "Test",
      command: "npm run test",
      status: "passed",
      durationMs: 900,
      output: "passed"
    }
  ]
};

function successfulUpgrade() {
  return {
    status: "VERIFIED" as const,
    commands: [
      command("git clone --depth 1 https://github.com/acme/widgets repo", 0),
      command("pnpm add left-pad@1.3.1", 0),
      command("pnpm install --frozen-lockfile", 0),
      command("pnpm run test", 0)
    ],
    skippedScripts: ["lint"],
    modelRepairRequired: false,
    runtimeChangeRequired: false
  };
}

function command(commandText: string, exitCode: number, output = "ok") {
  return {
    command: commandText,
    exitCode,
    durationMs: 10,
    output
  };
}
