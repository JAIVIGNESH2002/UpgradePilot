import { randomUUID } from "node:crypto";

import { runBaselineVerification } from "@/lib/baseline";
import {
  interruptedWorkspaceBaseline,
  verificationScriptLabel,
  workspaceBaselineFromVerificationResult
} from "@/lib/baseline-response";
import type { RepositoryInspection } from "@/lib/package-inspection";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";
import type { WorkspaceBaseline, WorkspaceBaselineStep } from "@/lib/repository-workspace";
import { readPositiveIntegerEnv } from "@/lib/run-store-retention";
import { TrueForgeSandboxProvider } from "@/lib/trueforge";
import type { VerificationPackageManager } from "@/lib/verification";
import { VERIFICATION_SCRIPT_ORDER, scriptCommandForPackageManager } from "@/lib/verification";

export type BaselineRunSnapshot = {
  id: string;
  repositoryUrl: string;
  status: "running" | "completed";
  baseline: WorkspaceBaseline;
};

type BaselineRunRecord = {
  id: string;
  repositoryUrl: string;
  status: "running" | "completed";
  baseline: WorkspaceBaseline;
  updatedAtMs: number;
};

type StartBaselineRunOptions = {
  inspectRepository?: typeof inspectPublicNpmRepository;
  runVerification?: typeof runBaselineVerification;
};

const baselineRuns = new Map<string, BaselineRunRecord>();
const DEFAULT_RUN_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RUNS = 100;
const DEFAULT_RUNNING_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_RUNS = 25;

export async function startBaselineRun(
  repositoryUrl: string,
  options: StartBaselineRunOptions = {}
): Promise<BaselineRunSnapshot> {
  const inspectRepository = options.inspectRepository ?? inspectPublicNpmRepository;
  const runVerification = options.runVerification ?? runBaselineVerification;
  const trimmedRepositoryUrl = repositoryUrl.trim();
  const runId = randomUUID();

  pruneBaselineRuns();

  if (
    activeBaselineRunCount() >=
    readPositiveIntegerEnv("UPGRADEPILOT_MAX_ACTIVE_RUNS", DEFAULT_MAX_ACTIVE_RUNS)
  ) {
    const record = completedRun({
      id: runId,
      repositoryUrl: trimmedRepositoryUrl,
      baseline: interruptedWorkspaceBaseline(
        "Too many baseline runs are active. Retry after existing runs finish."
      )
    });
    setBaselineRunRecord(record);
    return snapshotBaselineRun(record);
  }

  const inspection = await inspectRepository(trimmedRepositoryUrl, {
    token: process.env.GITHUB_TOKEN
  });

  if (!isSupportedVerificationPackageManager(inspection.package.packageManager.name)) {
    const record = completedRun({
      id: runId,
      repositoryUrl: trimmedRepositoryUrl,
      baseline: interruptedWorkspaceBaseline(
        `${inspection.package.packageManager.name} projects are detected but baseline execution is not supported yet.`
      )
    });
    setBaselineRunRecord(record);
    return snapshotBaselineRun(record);
  }

  const plannedSteps = baselinePlannedSteps(inspection);
  const record: BaselineRunRecord = {
    id: runId,
    repositoryUrl: trimmedRepositoryUrl,
    status: "running",
    baseline: {
      status: "unknown",
      updatedAt: null,
      commands: 0,
      message: "Baseline verification is running.",
      steps: runningBaselineSteps(plannedSteps)
    },
    updatedAtMs: Date.now()
  };
  setBaselineRunRecord(record);

  void completeBaselineRun({
    record,
    inspection,
    runVerification
  });

  return snapshotBaselineRun(record);
}

export function getBaselineRun(runId: string): BaselineRunSnapshot | null {
  pruneBaselineRuns();
  const record = baselineRuns.get(runId);

  if (!record) {
    return null;
  }

  return snapshotBaselineRun(record);
}

export function clearBaselineRunsForTests() {
  baselineRuns.clear();
}

function snapshotBaselineRun(record: BaselineRunRecord): BaselineRunSnapshot {
  return {
    id: record.id,
    repositoryUrl: record.repositoryUrl,
    status: record.status,
    baseline: record.baseline
  };
}

async function completeBaselineRun({
  record,
  inspection,
  runVerification
}: {
  record: BaselineRunRecord;
  inspection: RepositoryInspection;
  runVerification: typeof runBaselineVerification;
}) {
  try {
    const result = await runVerification({
      repositoryUrl: record.repositoryUrl,
      scripts: inspection.package.scripts,
      packageManager: inspection.package.packageManager.name as VerificationPackageManager,
      sandboxProvider: new TrueForgeSandboxProvider()
    });
    record.baseline = workspaceBaselineFromVerificationResult(
      result,
      inspection.package.packageManager.name as VerificationPackageManager
    );
  } catch (error) {
    record.baseline = interruptedWorkspaceBaseline(
      error instanceof Error ? error.message : "Baseline verification was interrupted."
    );
  } finally {
    record.status = "completed";
    record.updatedAtMs = Date.now();
    setBaselineRunRecord(record);
  }
}

function completedRun({
  id,
  repositoryUrl,
  baseline
}: {
  id: string;
  repositoryUrl: string;
  baseline: WorkspaceBaseline;
}): BaselineRunRecord {
  return {
    id,
    repositoryUrl,
    status: "completed",
    baseline,
    updatedAtMs: Date.now()
  };
}

function setBaselineRunRecord(record: BaselineRunRecord) {
  baselineRuns.set(record.id, record);
  pruneBaselineRuns();
}

function pruneBaselineRuns() {
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

  for (const [runId, record] of baselineRuns) {
    if (record.status === "running" && now - record.updatedAtMs > runningTimeoutMs) {
      record.status = "completed";
      record.updatedAtMs = now;
      record.baseline = interruptedWorkspaceBaseline(
        "Baseline verification was interrupted after the run stopped reporting progress."
      );
      baselineRuns.set(runId, record);
      continue;
    }

    if (record.status === "completed" && now - record.updatedAtMs > retentionMs) {
      baselineRuns.delete(runId);
    }
  }

  const completedRuns = [...baselineRuns.values()]
    .filter((record) => record.status === "completed")
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs);

  while (baselineRuns.size > maxRuns && completedRuns.length > 0) {
    const oldest = completedRuns.shift();

    if (oldest) {
      baselineRuns.delete(oldest.id);
    }
  }
}

function activeBaselineRunCount(): number {
  return [...baselineRuns.values()].filter((record) => record.status === "running").length;
}

function baselinePlannedSteps(inspection: RepositoryInspection): WorkspaceBaselineStep[] {
  const packageManager = inspection.package.packageManager.name;

  if (packageManager !== "npm" && packageManager !== "pnpm") {
    return [];
  }

  return [
    {
      name: "Install dependencies",
      command: inspection.package.packageManager.installCommand ?? "install",
      status: "pending",
      durationMs: null,
      output: null
    },
    ...VERIFICATION_SCRIPT_ORDER.map((scriptName) => ({
      name: verificationScriptLabel(scriptName),
      command: scriptCommandForPackageManager(packageManager, scriptName),
      status:
        inspection.package.scripts[scriptName] === undefined
          ? ("skipped" as const)
          : ("pending" as const),
      durationMs: null,
      output:
        inspection.package.scripts[scriptName] === undefined
          ? "Script not defined in package.json."
          : null
    }))
  ];
}

function runningBaselineSteps(steps: WorkspaceBaselineStep[]): WorkspaceBaselineStep[] {
  let activated = false;

  return steps.map((step) => {
    if (step.status === "skipped") {
      return step;
    }

    if (!activated) {
      activated = true;

      return {
        ...step,
        status: "running",
        output: "Waiting for TrueForge sandbox command output..."
      };
    }

    return {
      ...step,
      status: "pending"
    };
  });
}

function isSupportedVerificationPackageManager(
  packageManager: string
): packageManager is VerificationPackageManager {
  return packageManager === "npm" || packageManager === "pnpm";
}
