import { NextResponse } from "next/server";

import { runBaselineVerification } from "@/lib/baseline";
import {
  interruptedWorkspaceBaseline,
  workspaceBaselineFromVerificationResult
} from "@/lib/baseline-response";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";
import { TrueForgeSandboxProvider } from "@/lib/trueforge";
import type { VerificationPackageManager } from "@/lib/verification";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { repositoryUrl?: unknown };

    if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim() === "") {
      return NextResponse.json({ message: "Repository URL is required." }, { status: 400 });
    }

    const repositoryUrl = body.repositoryUrl.trim();
    const inspection = await inspectPublicNpmRepository(repositoryUrl, {
      token: process.env.GITHUB_TOKEN
    });

    if (!isSupportedVerificationPackageManager(inspection.package.packageManager.name)) {
      return NextResponse.json(
        {
          baseline: interruptedWorkspaceBaseline(
            `${inspection.package.packageManager.name} projects are detected but baseline execution is not supported yet.`
          )
        },
        { status: 200 }
      );
    }

    const result = await runBaselineVerification({
      repositoryUrl,
      scripts: inspection.package.scripts,
      packageManager: inspection.package.packageManager.name,
      sandboxProvider: new TrueForgeSandboxProvider()
    });

    return NextResponse.json({
      baseline: workspaceBaselineFromVerificationResult(
        result,
        inspection.package.packageManager.name
      )
    });
  } catch (error) {
    return NextResponse.json(
      {
        baseline: interruptedWorkspaceBaseline(
          error instanceof Error ? error.message : "Baseline verification was interrupted."
        )
      },
      { status: 200 }
    );
  }
}

function isSupportedVerificationPackageManager(
  packageManager: string
): packageManager is VerificationPackageManager {
  return packageManager === "npm" || packageManager === "pnpm";
}
