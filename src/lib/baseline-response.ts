import type { WorkspaceBaseline, WorkspaceBaselineStep } from "@/lib/repository-workspace";
import type {
  BaselineVerificationResult,
  CommandResult,
  VerificationPackageManager,
  VerificationScriptName
} from "@/lib/verification";
import { scriptCommandForPackageManager } from "@/lib/verification";

export function workspaceBaselineFromVerificationResult(
  result: BaselineVerificationResult,
  packageManager: VerificationPackageManager,
  updatedAt = new Date().toISOString()
): WorkspaceBaseline {
  return {
    status:
      result.status === "PASSED"
        ? "healthy"
        : result.status === "BLOCKED"
          ? "interrupted"
          : "failed",
    updatedAt,
    commands: 1 + result.verification.length,
    message: baselineMessage(result),
    steps: baselineSteps(result, packageManager)
  };
}

export function interruptedWorkspaceBaseline(
  message: string,
  updatedAt = new Date().toISOString()
): WorkspaceBaseline {
  return {
    status: "interrupted",
    updatedAt,
    commands: 0,
    message,
    steps: []
  };
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

export function verificationScriptLabel(scriptName: string) {
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
