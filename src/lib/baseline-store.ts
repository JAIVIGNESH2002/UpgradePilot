import type { BaselineVerificationResult } from "@/lib/verification";

export type BaselineRunState =
  | {
      status: "NOT_RUN";
    }
  | {
      status: "BLOCKED";
      message: string;
    }
  | {
      status: "COMPLETED";
      result: BaselineVerificationResult;
    };

const baselineRuns = new Map<string, BaselineRunState>();

export function getBaselineRun(repositoryUrl: string): BaselineRunState {
  return baselineRuns.get(repositoryUrl) ?? { status: "NOT_RUN" };
}

export function setBaselineRun(repositoryUrl: string, state: BaselineRunState) {
  baselineRuns.set(repositoryUrl, state);
}
