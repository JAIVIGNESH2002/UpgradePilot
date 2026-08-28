import {
  classifyBaselineStatus,
  discoverVerificationPlan,
  listMissingVerificationScripts,
  type BaselineVerificationResult,
  type CommandResult,
  type VerificationScriptName,
  truncateCommandOutput
} from "@/lib/verification";

export type SandboxWorkspace = {
  run(command: string): Promise<CommandResult>;
};

export type SandboxProvider = {
  createWorkspace(input: { repositoryUrl: string }): Promise<SandboxWorkspace>;
  runBaseline?(input: {
    repositoryUrl: string;
    scripts: Record<string, string>;
  }): Promise<BaselineVerificationResult>;
};

export type BaselineVerificationInput = {
  repositoryUrl: string;
  scripts: Record<string, string>;
  sandboxProvider: SandboxProvider;
};

export async function runBaselineVerification({
  repositoryUrl,
  scripts,
  sandboxProvider
}: BaselineVerificationInput): Promise<BaselineVerificationResult> {
  if (sandboxProvider.runBaseline) {
    return sandboxProvider.runBaseline({ repositoryUrl, scripts });
  }

  const workspace = await sandboxProvider.createWorkspace({ repositoryUrl });
  const install = await runWorkspaceCommand(workspace, "npm ci");

  if (install.exitCode !== 0) {
    return {
      status: "FAILED",
      install,
      verification: [],
      skippedScripts: listMissingVerificationScripts(scripts)
    };
  }

  const verification = [];

  for (const step of discoverVerificationPlan(scripts)) {
    verification.push(await runWorkspaceCommand(workspace, step.command));
  }

  return {
    status: classifyBaselineStatus({ install, verification }),
    install,
    verification,
    skippedScripts: listMissingVerificationScripts(scripts)
  };
}

export function commandResult({
  command,
  exitCode,
  durationMs,
  output
}: CommandResult): CommandResult {
  return {
    command,
    exitCode,
    durationMs,
    output: truncateCommandOutput(output)
  };
}

export function verificationScriptLabel(scriptName: VerificationScriptName) {
  return scriptName;
}

async function runWorkspaceCommand(
  workspace: SandboxWorkspace,
  command: string
): Promise<CommandResult> {
  return commandResult(await workspace.run(command));
}
