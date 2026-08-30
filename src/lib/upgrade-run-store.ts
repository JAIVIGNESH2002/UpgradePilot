import { randomUUID } from "node:crypto";

import type { WorkspaceBaseline, WorkspaceBaselineStepStatus } from "@/lib/repository-workspace";
import { readPositiveIntegerEnv } from "@/lib/run-store-retention";
import { TrueForgeSandboxProvider } from "@/lib/trueforge";
import type { CommandResult, VerificationPackageManager } from "@/lib/verification";

export type UpgradeRunStatus = "running" | "completed";
export type UpgradeRunOutcome = "verified" | "blocked" | "repair_failed" | "interrupted";
export type UpgradeRunStepStatus = WorkspaceBaselineStepStatus;

export type UpgradeRunStep = {
  name: string;
  command: string | null;
  status: UpgradeRunStepStatus;
  durationMs: number | null;
  output: string | null;
};

export type UpgradeRunSnapshot = {
  id: string;
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  packageManager: VerificationPackageManager;
  status: UpgradeRunStatus;
  outcome: UpgradeRunOutcome | null;
  message: string;
  steps: UpgradeRunStep[];
  startedAt: string;
  updatedAt: string | null;
  changedFiles: UpgradeRunChangedFile[];
  pullRequest: UpgradeRunPullRequest | null;
};

export type UpgradeRunChangedFile = {
  path: string;
  content: string;
};

export type UpgradeRunPullRequest = {
  url: string;
  number: number;
  branchName: string;
};

export type UpgradeVerificationResult = {
  status: "VERIFIED" | "FAILED" | "BLOCKED";
  commands: CommandResult[];
  skippedScripts: string[];
  modelRepairRequired: boolean;
  runtimeChangeRequired: boolean;
  sandboxId: string | null;
  cleanup: {
    status: "deleted" | "retained" | "failed";
    error?: string;
  } | null;
  changedFiles?: UpgradeRunChangedFile[];
};

export type UpgradeRepairHandoffResult = {
  status: "completed" | "failed";
  summary: string;
  sessionId: string | null;
  turnId: string | null;
  verificationResult: UpgradeVerificationResult | null;
};

type UpgradeRunRecord = UpgradeRunSnapshot & {
  startedAtMs?: number;
  updatedAtMs: number;
};

type StartUpgradeRunInput = {
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  changeType: "patch" | "minor" | "major";
  baseline: WorkspaceBaseline;
  packageManager: VerificationPackageManager;
};

type StartUpgradeRunOptions = {
  runVerification?: (input: {
    repositoryUrl: string;
    packageManager: VerificationPackageManager;
    packageName: string;
    targetVersion: string;
  }) => Promise<UpgradeVerificationResult>;
  runRepairHandoff?: (input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    verificationResult: UpgradeVerificationResult;
  }) => Promise<UpgradeRepairHandoffResult>;
  cleanupUpgradeSandbox?: (input: { sandboxId: string }) => Promise<void>;
};

const upgradeRuns = new Map<string, UpgradeRunRecord>();
const DEFAULT_RUN_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_RUNNING_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_RUNS = 25;

export function startUpgradeRun(
  input: StartUpgradeRunInput,
  options: StartUpgradeRunOptions = {}
): UpgradeRunSnapshot {
  const repositoryUrl = input.repositoryUrl.trim();
  const packageName = input.packageName.trim();
  const targetVersion = input.targetVersion.trim();
  const currentVersion = input.currentVersion.trim();
  const runId = randomUUID();

  if (repositoryUrl === "" || packageName === "" || targetVersion === "" || currentVersion === "") {
    return completedRun({
      id: runId,
      repositoryUrl,
      packageName,
      currentVersion,
      targetVersion,
      packageManager: input.packageManager,
      outcome: "interrupted",
      message: "Upgrade run is missing required repository or dependency version information.",
      steps: []
    });
  }

  pruneUpgradeRuns();

  if (
    activeUpgradeRunCount() >=
    readPositiveIntegerEnv("UPGRADEPILOT_MAX_ACTIVE_RUNS", DEFAULT_MAX_ACTIVE_RUNS)
  ) {
    return completedRun({
      id: runId,
      repositoryUrl,
      packageName,
      currentVersion,
      targetVersion,
      packageManager: input.packageManager,
      outcome: "interrupted",
      message: "Too many upgrade runs are active. Retry after existing runs finish.",
      steps: []
    });
  }

  if (input.baseline.status !== "healthy") {
    return completedRun({
      id: runId,
      repositoryUrl,
      packageName,
      currentVersion,
      targetVersion,
      packageManager: input.packageManager,
      outcome: "blocked",
      message: "A healthy baseline is required before deterministic upgrade verification can run.",
      steps: [
        {
          name: "Check baseline",
          command: null,
          status: "failed",
          durationMs: null,
          output: input.baseline.message ?? "Baseline is not healthy."
        }
      ]
    });
  }

  const upgradeCommand =
    input.packageManager === "pnpm"
      ? `pnpm add ${packageName}@${targetVersion}`
      : `npm install ${packageName}@${targetVersion}`;
  const verifyCommand =
    input.packageManager === "pnpm"
      ? "pnpm install --frozen-lockfile && pnpm run available checks"
      : "npm ci && npm run available checks";
  const steps = plannedUpgradeSteps({ upgradeCommand, verifyCommand });
  const record: UpgradeRunRecord = {
    id: runId,
    repositoryUrl,
    packageName,
    currentVersion,
    targetVersion,
    packageManager: input.packageManager,
    status: "running",
    outcome: null,
    message: "Running deterministic upgrade verification through TrueForge.",
    steps: runningUpgradeSteps(steps),
    startedAt: new Date().toISOString(),
    updatedAt: null,
    changedFiles: [],
    pullRequest: null,
    updatedAtMs: Date.now()
  };

  setUpgradeRunRecord(record);

  void completeUpgradeRun({
    runId: record.id,
    input: {
      repositoryUrl,
      packageManager: input.packageManager,
      packageName,
      targetVersion
    },
    runVerification:
      options.runVerification ??
      ((verificationInput) => new TrueForgeSandboxProvider().runUpgrade(verificationInput)),
    runRepairHandoff:
      options.runRepairHandoff ??
      ((repairInput) => new TrueForgeSandboxProvider().runUpgradeRepairHandoff(repairInput)),
    cleanupUpgradeSandbox:
      options.cleanupUpgradeSandbox ??
      ((cleanupInput) => new TrueForgeSandboxProvider().cleanupUpgradeSandbox(cleanupInput))
  });

  return snapshotUpgradeRun(record);
}

export function getUpgradeRun(runId: string): UpgradeRunSnapshot | null {
  pruneUpgradeRuns();
  const record = upgradeRuns.get(runId);

  return record ? snapshotUpgradeRun(record) : null;
}

export function clearUpgradeRunsForTests() {
  upgradeRuns.clear();
}

export function markUpgradeRunPullRequest(
  runId: string,
  pullRequest: UpgradeRunPullRequest
): UpgradeRunSnapshot | null {
  const record = upgradeRuns.get(runId);

  if (!record) {
    return null;
  }

  record.pullRequest = pullRequest;
  record.updatedAt = new Date().toISOString();
  record.updatedAtMs = Date.now();
  setUpgradeRunRecord(record);

  return snapshotUpgradeRun(record);
}

function snapshotUpgradeRun(record: UpgradeRunRecord): UpgradeRunSnapshot {
  return sanitizeRecord(record);
}

async function completeUpgradeRun({
  runId,
  input,
  runVerification,
  runRepairHandoff,
  cleanupUpgradeSandbox
}: {
  runId: string;
  input: {
    repositoryUrl: string;
    packageManager: VerificationPackageManager;
    packageName: string;
    targetVersion: string;
  };
  runVerification: NonNullable<StartUpgradeRunOptions["runVerification"]>;
  runRepairHandoff: NonNullable<StartUpgradeRunOptions["runRepairHandoff"]>;
  cleanupUpgradeSandbox: NonNullable<StartUpgradeRunOptions["cleanupUpgradeSandbox"]>;
}) {
  const record = upgradeRuns.get(runId);

  if (!record || record.status === "completed") {
    return;
  }

  try {
    const result = await runVerification(input);
    let repairHandoff: UpgradeRepairHandoffResult | null = null;
    let cleanupOutput: string | null = null;
    let finalResult = result;

    try {
      if (result.modelRepairRequired) {
        const repairAttempts: UpgradeRepairHandoffResult[] = [];
        const maxRepairAttempts = readRepairMaxAttempts();

        while (
          repairAttempts.length < maxRepairAttempts &&
          finalResult.modelRepairRequired &&
          finalResult.status === "FAILED" &&
          finalResult.sandboxId
        ) {
          const attempt = await runRepairHandoff({
            repositoryUrl: input.repositoryUrl,
            packageName: record.packageName,
            currentVersion: record.currentVersion,
            targetVersion: record.targetVersion,
            verificationResult: finalResult
          });
          repairAttempts.push(attempt);
          repairHandoff = mergeRepairAttempts(repairAttempts);

          if (!attempt.verificationResult) {
            break;
          }

          finalResult = attempt.verificationResult;
        }
      }
    } finally {
      cleanupOutput =
        result.cleanup?.status === "retained" && result.sandboxId !== null
          ? await cleanupRetainedUpgradeSandbox({
              sandboxId: result.sandboxId,
              cleanupUpgradeSandbox
            })
          : null;
    }

    record.status = "completed";
    record.outcome =
      finalResult.status === "VERIFIED"
        ? "verified"
        : finalResult.status === "BLOCKED"
          ? "blocked"
          : "repair_failed";
    record.message = upgradeRunMessage(finalResult, repairHandoff);
    record.steps = completedUpgradeSteps(record.steps, result, repairHandoff, cleanupOutput);
    record.changedFiles = finalResult.status === "VERIFIED" ? (finalResult.changedFiles ?? []) : [];
  } catch (error) {
    record.status = "completed";
    record.outcome = "interrupted";
    record.message =
      error instanceof Error ? error.message : "Upgrade verification was interrupted.";
    record.steps = interruptedUpgradeSteps(record.steps, record.message);
  } finally {
    record.updatedAt = new Date().toISOString();
    record.updatedAtMs = Date.now();
    setUpgradeRunRecord(record);
  }
}

function readRepairMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.UPGRADEPILOT_REPAIR_MAX_ATTEMPTS ?? "2", 10);

  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 3) : 2;
}

function mergeRepairAttempts(attempts: UpgradeRepairHandoffResult[]): UpgradeRepairHandoffResult {
  const lastAttempt = attempts.at(-1);

  return {
    status: attempts.every((attempt) => attempt.status === "completed") ? "completed" : "failed",
    summary: attempts
      .map((attempt, index) => `Attempt ${index + 1}: ${attempt.summary}`)
      .join("\n\n"),
    sessionId: lastAttempt?.sessionId ?? null,
    turnId: lastAttempt?.turnId ?? null,
    verificationResult: lastAttempt?.verificationResult ?? null
  };
}

function completedRun({
  id,
  repositoryUrl,
  packageName,
  currentVersion,
  targetVersion,
  packageManager,
  outcome,
  message,
  steps
}: {
  id: string;
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  packageManager: VerificationPackageManager;
  outcome: UpgradeRunOutcome;
  message: string;
  steps: UpgradeRunStep[];
}): UpgradeRunSnapshot {
  const now = new Date().toISOString();
  const snapshot: UpgradeRunRecord = {
    id,
    repositoryUrl,
    packageName,
    currentVersion,
    targetVersion,
    packageManager,
    status: "completed",
    outcome,
    message,
    steps,
    startedAt: now,
    updatedAt: now,
    changedFiles: [],
    pullRequest: null,
    updatedAtMs: Date.now()
  };

  setUpgradeRunRecord(snapshot);

  return snapshot;
}

function setUpgradeRunRecord(record: UpgradeRunRecord) {
  upgradeRuns.set(record.id, record);
  pruneUpgradeRuns();
}

function pruneUpgradeRuns() {
  const now = Date.now();
  const retentionMs = readPositiveIntegerEnv(
    "UPGRADEPILOT_RUN_RETENTION_MS",
    DEFAULT_RUN_RETENTION_MS
  );
  const maxRuns = readPositiveIntegerEnv("UPGRADEPILOT_MAX_RUNS", DEFAULT_MAX_RUNS);
  const runningTimeoutMs = readPositiveIntegerEnv(
    "UPGRADEPILOT_RUNNING_RUN_TIMEOUT_MS",
    DEFAULT_RUNNING_RUN_TIMEOUT_MS
  );

  for (const [runId, record] of upgradeRuns) {
    if (record.status === "running" && now - record.updatedAtMs > runningTimeoutMs) {
      record.status = "completed";
      record.outcome = "interrupted";
      record.message =
        "Upgrade verification was interrupted after the run stopped reporting progress.";
      record.steps = interruptedUpgradeSteps(record.steps, record.message);
      record.updatedAt = new Date(now).toISOString();
      record.updatedAtMs = now;
      upgradeRuns.set(runId, record);
      continue;
    }

    if (record.status === "completed" && now - record.updatedAtMs > retentionMs) {
      upgradeRuns.delete(runId);
    }
  }

  const completedRuns = [...upgradeRuns.values()]
    .filter((record) => record.status === "completed")
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs);

  while (upgradeRuns.size > maxRuns && completedRuns.length > 0) {
    const oldest = completedRuns.shift();

    if (oldest) {
      upgradeRuns.delete(oldest.id);
    }
  }
}

function activeUpgradeRunCount(): number {
  return [...upgradeRuns.values()].filter((record) => record.status === "running").length;
}

function plannedUpgradeSteps({
  upgradeCommand,
  verifyCommand
}: {
  upgradeCommand: string;
  verifyCommand: string;
}): UpgradeRunStep[] {
  return [
    {
      name: "Check baseline",
      command: null,
      status: "pending",
      durationMs: null,
      output: null
    },
    {
      name: "Create sandbox",
      command: "TrueForge deterministic sandbox",
      status: "pending",
      durationMs: null,
      output: null
    },
    {
      name: "Clone repository",
      command: "git clone <public repository>",
      status: "pending",
      durationMs: null,
      output: null
    },
    {
      name: "Install target dependency",
      command: upgradeCommand,
      status: "pending",
      durationMs: null,
      output: null
    },
    {
      name: "Run verification",
      command: verifyCommand,
      status: "pending",
      durationMs: null,
      output: null
    },
    {
      name: "Repair and re-verify",
      command: "TrueForge repair agent + deterministic verification",
      status: "pending",
      durationMs: null,
      output: null
    }
  ];
}

function runningUpgradeSteps(steps: UpgradeRunStep[]): UpgradeRunStep[] {
  let activated = false;

  return steps.map((step) => {
    if (step.name === "Check baseline") {
      return {
        ...step,
        status: "passed",
        output: "Healthy baseline was available before upgrade verification."
      };
    }

    if (step.status === "skipped") {
      return step;
    }

    if (!activated) {
      activated = true;

      return {
        ...step,
        status: "running",
        output: "Waiting for TrueForge deterministic upgrade workflow output..."
      };
    }

    return {
      ...step,
      status: "pending"
    };
  });
}

function interruptedUpgradeSteps(steps: UpgradeRunStep[], message: string): UpgradeRunStep[] {
  let markedFailure = false;

  return steps.map((step) => {
    if (!markedFailure && step.status === "running") {
      markedFailure = true;

      return {
        ...step,
        status: "failed",
        output: message
      };
    }

    return step;
  });
}

function completedUpgradeSteps(
  plannedSteps: UpgradeRunStep[],
  result: UpgradeVerificationResult,
  repairHandoff: UpgradeRepairHandoffResult | null,
  cleanupOutput: string | null
): UpgradeRunStep[] {
  const cloneCommand = result.commands.find((command) => command.command.startsWith("git clone"));
  const upgradeCommand = result.commands.find(
    (command) =>
      command.command.startsWith("npm install ") || command.command.startsWith("pnpm add ")
  );
  const installCommand = result.commands.find(
    (command) =>
      command.command === "npm ci" || command.command === "pnpm install --frozen-lockfile"
  );
  const verificationCommands = result.commands.filter(
    (command) => command.command.startsWith("npm run ") || command.command.startsWith("pnpm run ")
  );

  return plannedSteps.map((step) => {
    if (step.name === "Check baseline") {
      return {
        ...step,
        status: "passed",
        output: "Healthy baseline was available before upgrade verification."
      };
    }

    if (step.name === "Create sandbox") {
      return {
        ...step,
        status: "passed",
        output: "TrueForge created an isolated sandbox for deterministic upgrade verification."
      };
    }

    if (step.name === "Clone repository") {
      return commandStep(step, cloneCommand);
    }

    if (step.name === "Install target dependency") {
      return commandStep(step, upgradeCommand);
    }

    if (step.name === "Run verification") {
      return verificationStep(step, installCommand, verificationCommands);
    }

    if (step.name === "Repair and re-verify") {
      if (result.modelRepairRequired) {
        const repairVerification = repairHandoff?.verificationResult;
        return {
          ...step,
          status:
            repairHandoff?.status === "completed" && repairVerification?.status === "VERIFIED"
              ? "passed"
              : "failed",
          durationMs: repairVerification
            ? repairVerification.commands.reduce((total, command) => total + command.durationMs, 0)
            : 0,
          output: repairHandoff
            ? [repairHandoff.summary, repairVerificationSummary(repairVerification), cleanupOutput]
                .filter(Boolean)
                .join("\n\n")
            : "Model repair was requested, but no repair result was returned."
        };
      }

      return {
        ...step,
        status: "skipped",
        output: result.runtimeChangeRequired
          ? "Skipped because the failure is a runtime/install compatibility blocker."
          : "Skipped because the upgraded dependency passed deterministic verification."
      };
    }

    return step;
  });
}

function commandStep(step: UpgradeRunStep, command: CommandResult | undefined): UpgradeRunStep {
  if (!command) {
    return {
      ...step,
      status: "skipped",
      output: "This command was not reached."
    };
  }

  return {
    ...step,
    command: command.command,
    status: command.exitCode === 0 ? "passed" : "failed",
    durationMs: command.durationMs,
    output: command.output.trim() || null
  };
}

function verificationStep(
  step: UpgradeRunStep,
  installCommand: CommandResult | undefined,
  verificationCommands: CommandResult[]
): UpgradeRunStep {
  const failedCommand = [installCommand, ...verificationCommands].find(
    (command) => command !== undefined && command.exitCode !== 0
  );

  if (failedCommand) {
    return commandStep(step, failedCommand);
  }

  const completedCommands = [installCommand, ...verificationCommands].filter(Boolean).length;

  if (completedCommands === 0) {
    return {
      ...step,
      status: "skipped",
      output: "No install or verification command was reached."
    };
  }

  return {
    ...step,
    command: step.command,
    status: "passed",
    durationMs: [installCommand, ...verificationCommands].reduce(
      (total, command) => total + (command?.durationMs ?? 0),
      0
    ),
    output: `${completedCommands} verification command${completedCommands === 1 ? "" : "s"} passed after the upgrade.`
  };
}

async function cleanupRetainedUpgradeSandbox({
  sandboxId,
  cleanupUpgradeSandbox
}: {
  sandboxId: string;
  cleanupUpgradeSandbox: NonNullable<StartUpgradeRunOptions["cleanupUpgradeSandbox"]>;
}): Promise<string> {
  try {
    await cleanupUpgradeSandbox({ sandboxId });
    return `Retained sandbox ${sandboxId} was deleted after the repair handoff cycle.`;
  } catch (error) {
    return error instanceof Error
      ? `Retained sandbox cleanup failed: ${error.message}`
      : "Retained sandbox cleanup failed.";
  }
}

function repairVerificationSummary(
  result: UpgradeVerificationResult | null | undefined
): string | null {
  if (!result) {
    return null;
  }

  if (result.status === "VERIFIED") {
    return "Repair was applied and deterministic verification passed.";
  }

  const failedCommand = result.commands.find((command) => command.exitCode !== 0);

  return failedCommand
    ? [
        `Repair was applied, but ${failedCommand.command} still failed.`,
        failedCommand.output.trim() ? failedCommand.output.trim() : null
      ]
        .filter(Boolean)
        .join("\n")
    : "Repair verification did not pass.";
}

function upgradeRunMessage(
  result: UpgradeVerificationResult,
  repairHandoff: UpgradeRepairHandoffResult | null = null
): string {
  if (result.status === "VERIFIED") {
    return repairHandoff
      ? "Upgrade verified after repair. The repaired upgrade passed deterministic verification."
      : "Upgrade verified. The target version installed and all discovered checks passed.";
  }

  if (result.status === "BLOCKED") {
    return result.runtimeChangeRequired
      ? "Upgrade blocked by runtime or install compatibility requirements."
      : "Upgrade blocked before deterministic verification could complete.";
  }

  return result.modelRepairRequired
    ? "Upgrade changed CI behavior and the repair cycle did not produce a verified result."
    : "Upgrade verification failed.";
}

function sanitizeRecord(record: UpgradeRunRecord): UpgradeRunSnapshot {
  return {
    id: record.id,
    repositoryUrl: record.repositoryUrl,
    packageName: record.packageName,
    currentVersion: record.currentVersion,
    targetVersion: record.targetVersion,
    packageManager: record.packageManager,
    status: record.status,
    outcome: record.outcome,
    message: record.message,
    steps: record.steps,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    changedFiles: record.changedFiles,
    pullRequest: record.pullRequest
  };
}
