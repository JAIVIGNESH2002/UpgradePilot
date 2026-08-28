import {
  classifyBaselineStatus,
  discoverVerificationPlan,
  installCommandForPackageManager,
  listMissingVerificationScripts,
  type BaselineVerificationResult,
  type CommandResult,
  type VerificationPackageManager,
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
    packageManager: VerificationPackageManager;
  }): Promise<BaselineVerificationResult>;
};

export type BaselineVerificationInput = {
  repositoryUrl: string;
  scripts: Record<string, string>;
  packageManager?: VerificationPackageManager;
  sandboxProvider: SandboxProvider;
};

export async function runBaselineVerification({
  repositoryUrl,
  scripts,
  packageManager = "npm",
  sandboxProvider
}: BaselineVerificationInput): Promise<BaselineVerificationResult> {
  if (sandboxProvider.runBaseline) {
    return sandboxProvider.runBaseline({ repositoryUrl, scripts, packageManager });
  }

  const workspace = await sandboxProvider.createWorkspace({ repositoryUrl });
  const install = await runWorkspaceCommand(
    workspace,
    installCommandForPackageManager(packageManager)
  );

  if (install.exitCode !== 0) {
    return {
      status: "FAILED",
      install,
      verification: [],
      skippedScripts: listMissingVerificationScripts(scripts)
    };
  }

  const verification = [];

  for (const step of discoverVerificationPlan(scripts, packageManager)) {
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
