import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUpgradeRunsForTests, getUpgradeRun, startUpgradeRun } from "@/lib/upgrade-run-store";
import type { WorkspaceBaseline } from "@/lib/repository-workspace";

describe("upgrade-run-store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("evicts completed upgrade runs after the configured retention window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    vi.stubEnv("UPGRADEPILOT_RUN_RETENTION_MS", "1000");
    const run = startUpgradeRun({
      repositoryUrl: "https://github.com/acme/widgets",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      changeType: "minor",
      baseline: { ...healthyBaseline, status: "failed", message: "npm test failed" },
      packageManager: "npm"
    });

    expect(getUpgradeRun(run.id)).not.toBeNull();

    vi.setSystemTime(new Date("2026-08-28T10:00:01.001Z"));

    expect(getUpgradeRun(run.id)).toBeNull();
  });

  it("evicts oldest completed upgrade runs when the size limit is reached", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
    vi.stubEnv("UPGRADEPILOT_MAX_RUNS", "1");
    const first = startUpgradeRun({
      repositoryUrl: "https://github.com/acme/widgets",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      changeType: "minor",
      baseline: { ...healthyBaseline, status: "failed", message: "npm test failed" },
      packageManager: "npm"
    });

    vi.setSystemTime(new Date("2026-08-28T10:00:01Z"));

    const second = startUpgradeRun({
      repositoryUrl: "https://github.com/acme/widgets",
      packageName: "zod",
      currentVersion: "3.25.0",
      targetVersion: "4.4.3",
      changeType: "major",
      baseline: { ...healthyBaseline, status: "failed", message: "npm test failed" },
      packageManager: "npm"
    });

    expect(getUpgradeRun(first.id)).toBeNull();
    expect(getUpgradeRun(second.id)).not.toBeNull();
  });

  it("keeps deterministic upgrade workflow steps on known backend state without model calls", async () => {
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
    expect(run.steps[0]).toMatchObject({
      name: "Check baseline",
      status: "passed",
      output: "Healthy baseline was available before upgrade verification."
    });
    expect(run.steps[1]).toMatchObject({
      name: "Create sandbox",
      status: "running",
      output: "Waiting for TrueForge deterministic upgrade workflow output..."
    });
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
    expect(progressedRun?.steps[2]?.status).toBe("pending");

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
      turnId: "turn-1",
      verificationResult: successfulUpgrade()
    }));
    const cleanupUpgradeSandbox = vi.fn(async () => undefined);
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
          runtimeChangeRequired: false,
          sandboxId: "default.sandbox-1",
          cleanup: { status: "retained" as const }
        })),
        runRepairHandoff,
        cleanupUpgradeSandbox
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
    expect(cleanupUpgradeSandbox).toHaveBeenCalledWith({ sandboxId: "default.sandbox-1" });
    expect(completedRun?.outcome).toBe("verified");
    expect(completedRun?.message).toContain("verified after repair");
    expect(completedRun?.steps.at(-1)?.status).toBe("passed");
    expect(completedRun?.steps.at(-1)?.output).toContain("API compatibility");
    expect(completedRun?.steps.at(-1)?.output).toContain("Repair was applied");
    expect(completedRun?.steps.at(-1)?.output).toContain("was deleted after the repair handoff");
  });

  it("reports a repair failure when re-verification still fails", async () => {
    const cleanupUpgradeSandbox = vi.fn(async () => undefined);
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "zod",
        currentVersion: "3.25.0",
        targetVersion: "4.4.3",
        changeType: "major",
        baseline: healthyBaseline,
        packageManager: "npm"
      },
      {
        runVerification: vi.fn(async () => repairableFailure()),
        runRepairHandoff: vi.fn(async () => ({
          status: "completed" as const,
          summary: "Repair patch was applied.",
          sessionId: "session-1",
          turnId: "turn-1",
          verificationResult: {
            ...repairableFailure(),
            cleanup: { status: "retained" as const },
            commands: [
              command(
                "git apply --whitespace=nowarn /opt/tf/tool-results/upgradepilot-repair.patch",
                0
              ),
              command("npm ci", 0),
              command("npm run typecheck", 1, "still failed")
            ],
            modelRepairRequired: false
          }
        })),
        cleanupUpgradeSandbox
      }
    );

    await vi.waitFor(() => expect(getUpgradeRun(run.id)?.status).toBe("completed"));
    const completedRun = getUpgradeRun(run.id);

    expect(completedRun?.outcome).toBe("repair_failed");
    expect(completedRun?.steps.at(-1)?.status).toBe("failed");
    expect(completedRun?.steps.at(-1)?.output).toContain("npm run typecheck");
    expect(cleanupUpgradeSandbox).toHaveBeenCalledWith({ sandboxId: "default.sandbox-1" });
  });

  it("attempts one additional repair when repaired verification is still source-repairable", async () => {
    const cleanupUpgradeSandbox = vi.fn(async () => undefined);
    const runRepairHandoff = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed" as const,
        summary: "First repair updated deprecated schema options.",
        sessionId: "session-1",
        turnId: "turn-1",
        verificationResult: {
          ...repairableFailure(),
          commands: [
            command("apply structured repair file replacements", 0),
            command("npm ci", 0),
            command(
              "npm run typecheck",
              1,
              "Property 'errors' does not exist on type 'ZodError<unknown>'."
            )
          ],
          modelRepairRequired: true,
          sandboxId: "default.sandbox-1",
          cleanup: { status: "retained" as const }
        }
      })
      .mockResolvedValueOnce({
        status: "completed" as const,
        summary: "Second repair changed error.errors to error.issues.",
        sessionId: "session-2",
        turnId: "turn-2",
        verificationResult: successfulUpgrade()
      });
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "zod",
        currentVersion: "3.25.0",
        targetVersion: "4.4.3",
        changeType: "major",
        baseline: healthyBaseline,
        packageManager: "npm"
      },
      {
        runVerification: vi.fn(async () => repairableFailure()),
        runRepairHandoff,
        cleanupUpgradeSandbox
      }
    );

    await vi.waitFor(() => expect(getUpgradeRun(run.id)?.status).toBe("completed"));
    const completedRun = getUpgradeRun(run.id);

    expect(runRepairHandoff).toHaveBeenCalledTimes(2);
    expect(runRepairHandoff).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        verificationResult: expect.objectContaining({
          commands: expect.arrayContaining([
            expect.objectContaining({
              command: "npm run typecheck",
              output: expect.stringContaining("Property 'errors'")
            })
          ])
        })
      })
    );
    expect(completedRun?.outcome).toBe("verified");
    expect(completedRun?.steps.at(-1)?.output).toContain("Attempt 2");
    expect(cleanupUpgradeSandbox).toHaveBeenCalledWith({ sandboxId: "default.sandbox-1" });
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
          runtimeChangeRequired: true,
          sandboxId: "default.sandbox-1",
          cleanup: { status: "deleted" as const }
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
    runtimeChangeRequired: false,
    sandboxId: "default.sandbox-1",
    cleanup: { status: "deleted" as const }
  };
}

function repairableFailure() {
  return {
    status: "FAILED" as const,
    commands: [
      command("git clone --depth 1 https://github.com/acme/widgets repo", 0),
      command("npm install zod@4.4.3", 0),
      command("npm ci", 0),
      command("npm run typecheck", 1, "zod v4 type error")
    ],
    skippedScripts: [],
    modelRepairRequired: true,
    runtimeChangeRequired: false,
    sandboxId: "default.sandbox-1",
    cleanup: { status: "retained" as const }
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
