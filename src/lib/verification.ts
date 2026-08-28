export const VERIFICATION_SCRIPT_ORDER = [
  "format:check",
  "lint",
  "typecheck",
  "test",
  "build"
] as const;

export type VerificationScriptName = (typeof VERIFICATION_SCRIPT_ORDER)[number];
export type BaselineStatus = "PASSED" | "FAILED";
export type VerificationPackageManager = "npm" | "pnpm";

export type VerificationPlanStep = {
  scriptName: VerificationScriptName;
  command: string;
};

export type CommandResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
};

export type BaselineVerificationResult = {
  status: BaselineStatus;
  install: CommandResult;
  verification: CommandResult[];
  skippedScripts: VerificationScriptName[];
};

export function installCommandForPackageManager(
  packageManager: VerificationPackageManager
): string {
  return packageManager === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci";
}

export function scriptCommandForPackageManager(
  packageManager: VerificationPackageManager,
  scriptName: VerificationScriptName
): string {
  return packageManager === "pnpm" ? `pnpm run ${scriptName}` : `npm run ${scriptName}`;
}

export function discoverVerificationPlan(
  scripts: Record<string, string>,
  packageManager: VerificationPackageManager = "npm"
): VerificationPlanStep[] {
  return VERIFICATION_SCRIPT_ORDER.filter((scriptName) => scripts[scriptName] !== undefined).map(
    (scriptName) => ({
      scriptName,
      command: scriptCommandForPackageManager(packageManager, scriptName)
    })
  );
}

export function listMissingVerificationScripts(
  scripts: Record<string, string>
): VerificationScriptName[] {
  return VERIFICATION_SCRIPT_ORDER.filter((scriptName) => scripts[scriptName] === undefined);
}

export function classifyBaselineStatus(results: {
  install: CommandResult;
  verification: CommandResult[];
}): BaselineStatus {
  if (results.install.exitCode !== 0) {
    return "FAILED";
  }

  return results.verification.every((result) => result.exitCode === 0) ? "PASSED" : "FAILED";
}

export function truncateCommandOutput(output: string, maxLength = 4000): string {
  const normalized = output.replace(/\r\n/g, "\n").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n[output truncated]`;
}
