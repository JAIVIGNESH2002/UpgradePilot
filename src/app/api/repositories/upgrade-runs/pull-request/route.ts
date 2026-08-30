import { NextResponse } from "next/server";

import { GitHubClient } from "@/lib/github";
import { getUpgradeRun, markUpgradeRunPullRequest } from "@/lib/upgrade-run-store";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { runId?: unknown };
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";

    if (runId === "") {
      return NextResponse.json({ message: "Upgrade run ID is required." }, { status: 400 });
    }

    const run = getUpgradeRun(runId);

    if (!run) {
      return NextResponse.json({ message: "Upgrade run was not found." }, { status: 404 });
    }

    if (run.status !== "completed" || run.outcome !== "verified") {
      return NextResponse.json(
        { message: "A pull request can only be created after a verified upgrade run." },
        { status: 409 }
      );
    }

    if (run.pullRequest) {
      return NextResponse.json({ run, pullRequest: run.pullRequest }, { status: 200 });
    }

    if (run.changedFiles.length === 0) {
      return NextResponse.json(
        { message: "The verified upgrade run did not include changed files for a pull request." },
        { status: 409 }
      );
    }

    const lockfilePath = expectedLockfilePath(run.packageManager);
    if (lockfilePath && !run.changedFiles.some((file) => file.path === lockfilePath)) {
      return NextResponse.json(
        {
          message: `The verified upgrade run did not include ${lockfilePath}. UpgradePilot will not create a manifest-only dependency PR.`
        },
        { status: 409 }
      );
    }

    const branchName = prBranchName(run.packageName, run.targetVersion);
    const title = `chore: upgrade ${run.packageName} to ${run.targetVersion}`;
    const pullRequest = await new GitHubClient({
      token: process.env.GITHUB_TOKEN
    }).createPullRequest({
      repositoryUrl: run.repositoryUrl,
      branchName,
      title,
      body: buildPullRequestBody(run),
      files: run.changedFiles
    });
    const updatedRun = markUpgradeRunPullRequest(run.id, pullRequest) ?? run;

    return NextResponse.json({ run: updatedRun, pullRequest }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Pull request creation failed." },
      { status: 400 }
    );
  }
}

type PullRequestBodyRun = NonNullable<ReturnType<typeof getUpgradeRun>>;

function buildPullRequestBody(run: PullRequestBodyRun): string {
  const verifiedSteps = run.steps
    .filter((step) => step.status === "passed" && step.command)
    .map((step) => `- ${step.name}: ${step.command}`);

  return [
    `UpgradePilot verified ${run.packageName} from ${run.currentVersion} to ${run.targetVersion}.`,
    "",
    "## Agent Changes",
    ...describeAgentChanges(run.changedFiles),
    "",
    "## Verification Evidence",
    ...(verifiedSteps.length > 0 ? verifiedSteps : ["- No command evidence was recorded."]),
    "",
    "## Remaining Risk",
    "- No known remaining risk after successful sandbox verification. Human review is still required before merge."
  ].join("\n");
}

function describeAgentChanges(files: Array<{ path: string }>): string[] {
  return files.map((file) => {
    if (file.path === "package.json") {
      return "- `package.json`: updates the requested dependency declaration.";
    }

    if (file.path === "package-lock.json" || file.path === "pnpm-lock.yaml") {
      return `- \`${file.path}\`: records the resolved dependency graph for the verified upgrade.`;
    }

    return `- \`${file.path}\`: applies compatibility changes produced by the repair workflow.`;
  });
}

function prBranchName(packageName: string, targetVersion: string): string {
  const slug = `${packageName}-${targetVersion}`
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `upgradepilot/${slug || "dependency-upgrade"}-${Date.now()}`;
}

function expectedLockfilePath(packageManager: string): string | null {
  if (packageManager === "npm") {
    return "package-lock.json";
  }

  if (packageManager === "pnpm") {
    return "pnpm-lock.yaml";
  }

  return null;
}
