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

    const branchName = prBranchName(run.packageName, run.targetVersion);
    const title = `chore: upgrade ${run.packageName} to ${run.targetVersion}`;
    const pullRequest = await new GitHubClient({ token: process.env.GITHUB_TOKEN }).createPullRequest({
      repositoryUrl: run.repositoryUrl,
      branchName,
      title,
      body: [
        `UpgradePilot verified ${run.packageName} from ${run.currentVersion} to ${run.targetVersion}.`,
        "",
        "Verification evidence:",
        ...run.steps
          .filter((step) => step.status === "passed" && step.command)
          .map((step) => `- ${step.name}: ${step.command}`)
      ].join("\n"),
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

function prBranchName(packageName: string, targetVersion: string): string {
  const slug = `${packageName}-${targetVersion}`
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `upgradepilot/${slug || "dependency-upgrade"}-${Date.now()}`;
}
