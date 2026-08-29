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
  startedAt: number;
  plannedSteps: WorkspaceBaselineStep[];
  baseline: WorkspaceBaseline;
};

type StartBaselineRunOptions = {
  inspectRepository?: typeof inspectPublicNpmRepository;
  runVerification?: typeof runBaselineVerification;
};

const baselineRuns = new Map<string, BaselineRunRecord>();
const STEP_ADVANCE_MS = 1800;

export async function startBaselineRun(
  repositoryUrl: string,
  options: StartBaselineRunOptions = {}
): Promise<BaselineRunSnapshot> {
  const inspectRepository = options.inspectRepository ?? inspectPublicNpmRepository;
  const runVerification = options.runVerification ?? runBaselineVerification;
  const trimmedRepositoryUrl = repositoryUrl.trim();
  const inspection = await inspectRepository(trimmedRepositoryUrl, {
    token: process.env.GITHUB_TOKEN
  });
  const runId = randomUUID();

  if (!isSupportedVerificationPackageManager(inspection.package.packageManager.name)) {
    const record = completedRun({
      id: runId,
      repositoryUrl: trimmedRepositoryUrl,
      baseline: interruptedWorkspaceBaseline(
        `${inspection.package.packageManager.name} projects are detected but baseline execution is not supported yet.`
      )
    });
    baselineRuns.set(runId, record);
    return snapshotBaselineRun(record);
  }

  const plannedSteps = baselinePlannedSteps(inspection);
  const record: BaselineRunRecord = {
    id: runId,
    repositoryUrl: trimmedRepositoryUrl,
    status: "running",
    startedAt: Date.now(),
    plannedSteps,
    baseline: {
      status: "unknown",
      updatedAt: null,
      commands: 0,
      message: "Baseline verification is running.",
      steps: runningBaselineSteps(plannedSteps, 0)
    }
  };
  baselineRuns.set(runId, record);

  void completeBaselineRun({
    record,
    inspection,
    runVerification
  });

  return snapshotBaselineRun(record);
}

export function getBaselineRun(runId: string): BaselineRunSnapshot | null {
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
  if (record.status === "completed") {
    return {
      id: record.id,
      repositoryUrl: record.repositoryUrl,
      status: "completed",
      baseline: record.baseline
    };
  }

  const activeStepIndex = Math.min(
    Math.floor((Date.now() - record.startedAt) / STEP_ADVANCE_MS),
    Math.max(record.plannedSteps.length - 1, 0)
  );

  return {
    id: record.id,
    repositoryUrl: record.repositoryUrl,
    status: "running",
    baseline: {
      ...record.baseline,
      steps: runningBaselineSteps(record.plannedSteps, activeStepIndex)
    }
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
    baselineRuns.set(record.id, record);
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
    startedAt: Date.now(),
    plannedSteps: [],
    baseline
  };
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

function runningBaselineSteps(
  steps: WorkspaceBaselineStep[],
  activeStepIndex: number
): WorkspaceBaselineStep[] {
  return steps.map((step, index) => ({
    ...step,
    status:
      step.status === "skipped" ? "skipped" : index === activeStepIndex ? "running" : "pending"
  }));
}

function isSupportedVerificationPackageManager(
  packageManager: string
): packageManager is VerificationPackageManager {
  return packageManager === "npm" || packageManager === "pnpm";
}
