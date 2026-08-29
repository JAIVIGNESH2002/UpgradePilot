import { randomUUID } from "node:crypto";

import type { WorkspaceBaseline, WorkspaceBaselineStepStatus } from "@/lib/repository-workspace";
import { TrueForgeSandboxProvider } from "@/lib/trueforge";
import type { CommandResult, VerificationPackageManager } from "@/lib/verification";

export type UpgradeRunStatus = "running" | "completed";
export type UpgradeRunOutcome = "verified" | "blocked" | "repair_simulated" | "interrupted";
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
  status: UpgradeRunStatus;
  outcome: UpgradeRunOutcome | null;
  message: string;
  steps: UpgradeRunStep[];
  startedAt: string;
  updatedAt: string | null;
};

export type UpgradeVerificationResult = {
  status: "VERIFIED" | "FAILED" | "BLOCKED";
  commands: CommandResult[];
  skippedScripts: string[];
  modelRepairRequired: boolean;
  runtimeChangeRequired: boolean;
};

export type UpgradeRepairHandoffResult = {
  status: "completed" | "failed";
  summary: string;
  sessionId: string | null;
  turnId: string | null;
};

type UpgradeRunRecord = UpgradeRunSnapshot & {
  startedAtMs: number;
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
};

const upgradeRuns = new Map<string, UpgradeRunRecord>();
const STEP_ADVANCE_MS = 1600;

export function startUpgradeRun(
  input: StartUpgradeRunInput,
  options: StartUpgradeRunOptions = {}
): UpgradeRunSnapshot {
  const repositoryUrl = input.repositoryUrl.trim();
  const packageName = input.packageName.trim();
  const targetVersion = input.targetVersion.trim();
  const currentVersion = input.currentVersion.trim();
  const now = Date.now();
  const runId = randomUUID();

  if (repositoryUrl === "" || packageName === "" || targetVersion === "" || currentVersion === "") {
    return completedRun({
      id: runId,
      repositoryUrl,
      packageName,
      currentVersion,
      targetVersion,
      outcome: "interrupted",
      message: "Upgrade run is missing required repository or dependency version information.",
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
    status: "running",
    outcome: null,
    message: "Running deterministic upgrade verification through TrueForge.",
    steps: runningUpgradeSteps(steps, 0),
    startedAt: new Date(now).toISOString(),
    updatedAt: null,
    startedAtMs: now
  };

  upgradeRuns.set(runId, record);

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
      ((repairInput) => new TrueForgeSandboxProvider().runUpgradeRepairHandoff(repairInput))
  });

  return snapshotUpgradeRun(record);
}

export function getUpgradeRun(runId: string): UpgradeRunSnapshot | null {
  const record = upgradeRuns.get(runId);

  return record ? snapshotUpgradeRun(record) : null;
}

export function clearUpgradeRunsForTests() {
  upgradeRuns.clear();
}

function snapshotUpgradeRun(record: UpgradeRunRecord): UpgradeRunSnapshot {
  if (record.status === "completed") {
    return sanitizeRecord(record);
  }

  const activeStepIndex = Math.min(
    Math.floor((Date.now() - record.startedAtMs) / STEP_ADVANCE_MS),
    Math.max(record.steps.length - 1, 0)
  );

  return {
    ...sanitizeRecord(record),
    steps: runningUpgradeSteps(record.steps, activeStepIndex)
  };
}

async function completeUpgradeRun({
  runId,
  input,
  runVerification,
  runRepairHandoff
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
}) {
  const record = upgradeRuns.get(runId);

  if (!record || record.status === "completed") {
    return;
  }

  try {
    const result = await runVerification(input);
    const repairHandoff = result.modelRepairRequired
      ? await runRepairHandoff({
          repositoryUrl: input.repositoryUrl,
          packageName: record.packageName,
          currentVersion: record.currentVersion,
          targetVersion: record.targetVersion,
          verificationResult: result
        })
      : null;
    record.status = "completed";
    record.outcome =
      result.status === "VERIFIED"
        ? "verified"
        : result.status === "BLOCKED"
          ? "blocked"
          : "repair_simulated";
    record.message = upgradeRunMessage(result);
    record.steps = completedUpgradeSteps(record.steps, result, repairHandoff);
  } catch (error) {
    record.status = "completed";
    record.outcome = "interrupted";
    record.message =
      error instanceof Error ? error.message : "Upgrade verification was interrupted.";
    record.steps = record.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "failed" : step.status,
      output: index === 0 ? record.message : step.output
    }));
  } finally {
    record.updatedAt = new Date().toISOString();
    upgradeRuns.set(runId, record);
  }
}

function completedRun({
  id,
  repositoryUrl,
  packageName,
  currentVersion,
  targetVersion,
  outcome,
  message,
  steps
}: {
  id: string;
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  outcome: UpgradeRunOutcome;
  message: string;
  steps: UpgradeRunStep[];
}): UpgradeRunSnapshot {
  const now = new Date().toISOString();
  const snapshot: UpgradeRunSnapshot = {
    id,
    repositoryUrl,
    packageName,
    currentVersion,
    targetVersion,
    status: "completed",
    outcome,
    message,
    steps,
    startedAt: now,
    updatedAt: now
  };

  upgradeRuns.set(id, { ...snapshot, startedAtMs: Date.now() });

  return snapshot;
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
      name: "Repair agent handoff",
      command: "TrueForge repair agent handoff",
      status: "pending",
      durationMs: null,
      output: null
    }
  ];
}

function runningUpgradeSteps(steps: UpgradeRunStep[], activeStepIndex: number): UpgradeRunStep[] {
  return steps.map((step, index) => ({
    ...step,
    status:
      step.status === "skipped"
        ? "skipped"
        : index < activeStepIndex
          ? "passed"
          : index === activeStepIndex
            ? "running"
            : "pending"
  }));
}

function completedUpgradeSteps(
  plannedSteps: UpgradeRunStep[],
  result: UpgradeVerificationResult,
  repairHandoff: UpgradeRepairHandoffResult | null
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

    if (step.name === "Repair agent handoff") {
      if (result.modelRepairRequired) {
        return {
          ...step,
          status: repairHandoff?.status === "failed" ? "failed" : "passed",
          durationMs: 0,
          output: repairHandoff
            ? repairHandoff.summary
            : "Model repair handoff was requested, but no handoff result was returned."
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

function upgradeRunMessage(result: UpgradeVerificationResult): string {
  if (result.status === "VERIFIED") {
    return "Upgrade verified. The target version installed and all discovered checks passed.";
  }

  if (result.status === "BLOCKED") {
    return result.runtimeChangeRequired
      ? "Upgrade blocked by runtime or install compatibility requirements."
      : "Upgrade blocked before deterministic verification could complete.";
  }

  return result.modelRepairRequired
    ? "Upgrade changed CI behavior. TrueForge repair agent handoff completed; applying fixes comes next."
    : "Upgrade verification failed.";
}

function sanitizeRecord(record: UpgradeRunRecord): UpgradeRunSnapshot {
  return {
    id: record.id,
    repositoryUrl: record.repositoryUrl,
    packageName: record.packageName,
    currentVersion: record.currentVersion,
    targetVersion: record.targetVersion,
    status: record.status,
    outcome: record.outcome,
    message: record.message,
    steps: record.steps,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt
  };
}
