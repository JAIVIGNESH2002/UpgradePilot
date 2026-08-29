import { NextResponse } from "next/server";

import { runBaselineVerification } from "@/lib/baseline";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";
import type { WorkspaceBaselineStep } from "@/lib/repository-workspace";
import { TrueForgeSandboxProvider } from "@/lib/trueforge";
import type {
  BaselineVerificationResult,
  CommandResult,
  VerificationPackageManager,
  VerificationScriptName
} from "@/lib/verification";
import { scriptCommandForPackageManager } from "@/lib/verification";

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
          baseline: {
            status: "interrupted",
            updatedAt: new Date().toISOString(),
            commands: 0,
            message: `${inspection.package.packageManager.name} projects are detected but baseline execution is not supported yet.`,
            steps: []
          }
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
      baseline: {
        status:
          result.status === "PASSED"
            ? "healthy"
            : result.status === "BLOCKED"
              ? "interrupted"
              : "failed",
        updatedAt: new Date().toISOString(),
        commands: 1 + result.verification.length,
        message: baselineMessage(result),
        steps: baselineSteps(result, inspection.package.packageManager.name)
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        baseline: {
          status: "interrupted",
          updatedAt: new Date().toISOString(),
          commands: 0,
          message:
            error instanceof Error ? error.message : "Baseline verification was interrupted.",
          steps: []
        }
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

function baselineMessage(result: BaselineVerificationResult): string | null {
  if (result.status === "PASSED") {
    return null;
  }

  const failedCommand = [result.install, ...result.verification].find(
    (command) => command.exitCode !== 0
  );

  if (!failedCommand) {
    return null;
  }

  return failedCommandMessage(failedCommand);
}

function failedCommandMessage(command: CommandResult): string {
  const output = command.output.trim();

  if (!output) {
    return `${command.command} exited with code ${command.exitCode}.`;
  }

  return `${command.command} exited with code ${command.exitCode}: ${output}`;
}

function baselineSteps(
  result: BaselineVerificationResult,
  packageManager: VerificationPackageManager
): WorkspaceBaselineStep[] {
  return [
    commandStep("Install dependencies", result.install),
    ...result.verification.map((command) => commandStep(verificationStepName(command), command)),
    ...result.skippedScripts.map((scriptName) => ({
      name: verificationScriptLabel(scriptName),
      command: scriptCommandForPackageManager(packageManager, scriptName),
      status: "skipped" as const,
      durationMs: null,
      output: "Script not defined in package.json."
    }))
  ];
}

function commandStep(name: string, command: CommandResult): WorkspaceBaselineStep {
  return {
    name,
    command: command.command,
    status: command.exitCode === 0 ? "passed" : "failed",
    durationMs: command.durationMs,
    output: command.output.trim() || null
  };
}

function verificationStepName(command: CommandResult): string {
  const scriptName = command.command.split(" run ").at(1);

  return isVerificationScriptName(scriptName)
    ? verificationScriptLabel(scriptName)
    : "Verification command";
}

function verificationScriptLabel(scriptName: VerificationScriptName): string {
  return scriptName === "format:check"
    ? "Format check"
    : scriptName.charAt(0).toUpperCase() + scriptName.slice(1);
}

function isVerificationScriptName(input: string | undefined): input is VerificationScriptName {
  return (
    input === "format:check" ||
    input === "lint" ||
    input === "typecheck" ||
    input === "test" ||
    input === "build"
  );
}
