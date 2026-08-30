import { NextResponse } from "next/server";

import { startUpgradeRun } from "@/lib/upgrade-run-store";
import type { WorkspaceBaseline } from "@/lib/repository-workspace";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      repositoryUrl?: unknown;
      packageName?: unknown;
      currentVersion?: unknown;
      targetVersion?: unknown;
      changeType?: unknown;
      baseline?: unknown;
      packageManager?: unknown;
    };

    if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim() === "") {
      return NextResponse.json({ message: "Repository URL is required." }, { status: 400 });
    }

    if (typeof body.packageName !== "string" || body.packageName.trim() === "") {
      return NextResponse.json({ message: "Package name is required." }, { status: 400 });
    }

    if (typeof body.currentVersion !== "string" || body.currentVersion.trim() === "") {
      return NextResponse.json({ message: "Current version is required." }, { status: 400 });
    }

    if (typeof body.targetVersion !== "string" || body.targetVersion.trim() === "") {
      return NextResponse.json({ message: "Target version is required." }, { status: 400 });
    }

    if (body.changeType !== "patch" && body.changeType !== "minor" && body.changeType !== "major") {
      return NextResponse.json({ message: "A valid upgrade target is required." }, { status: 400 });
    }

    if (body.packageManager !== "npm" && body.packageManager !== "pnpm") {
      return NextResponse.json(
        { message: "Only npm and pnpm upgrade verification is supported." },
        { status: 400 }
      );
    }

    if (!isWorkspaceBaseline(body.baseline)) {
      return NextResponse.json({ message: "Baseline result is required." }, { status: 400 });
    }

    const run = startUpgradeRun({
      repositoryUrl: body.repositoryUrl,
      packageName: body.packageName,
      currentVersion: body.currentVersion,
      targetVersion: body.targetVersion,
      changeType: body.changeType,
      baseline: body.baseline,
      packageManager: body.packageManager
    });

    return NextResponse.json({ run }, { status: run.status === "running" ? 202 : 200 });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Upgrade run failed to start." },
      { status: 400 }
    );
  }
}

function isWorkspaceBaseline(input: unknown): input is WorkspaceBaseline {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Partial<WorkspaceBaseline>;

  return (
    (candidate.status === "unknown" ||
      candidate.status === "healthy" ||
      candidate.status === "failed" ||
      candidate.status === "interrupted") &&
    (typeof candidate.updatedAt === "string" || candidate.updatedAt === null) &&
    typeof candidate.commands === "number" &&
    (typeof candidate.message === "string" || candidate.message === null) &&
    Array.isArray(candidate.steps)
  );
}
