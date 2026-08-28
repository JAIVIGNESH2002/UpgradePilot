import { VERIFICATION_SCRIPT_ORDER } from "@/lib/verification";
import type { VerificationPackageManager } from "@/lib/verification";

export const UPGRADEPILOT_BASELINE_RESULT_MARKER = "UPGRADEPILOT_BASELINE_RESULT";

export function buildNpmBaselineWorkflowScript(
  repositoryUrl: string,
  packageManager: VerificationPackageManager = "npm"
): string {
  const installCommand =
    packageManager === "pnpm" ? ["pnpm", "install", "--frozen-lockfile"] : ["npm", "ci"];
  const scriptRunner = packageManager === "pnpm" ? "pnpm" : "npm";

  return `
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const repositoryUrl = ${JSON.stringify(repositoryUrl)};
const verificationScriptOrder = ${JSON.stringify([...VERIFICATION_SCRIPT_ORDER])};
const installCommand = ${JSON.stringify(installCommand)};
const scriptRunner = ${JSON.stringify(scriptRunner)};

function now() {
  return Date.now();
}

function conciseOutput(stdout, stderr, exitCode) {
  const combined = [stdout, stderr].filter(Boolean).join("\\n").replace(/\\r\\n/g, "\\n").trim();
  const limit = exitCode === 0 ? 1200 : 4000;
  if (combined.length <= limit) return combined;
  return combined.slice(Math.max(0, combined.length - limit)) + "\\n[output truncated]";
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const start = now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, CI: "true", NO_COLOR: "1" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode: 1,
        durationMs: now() - start,
        output: String(error.message || error)
      });
    });
    child.on("close", (code) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        durationMs: now() - start,
        output: conciseOutput(stdout, stderr, code ?? 1)
      });
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  const workdir = mkdtempSync(join(tmpdir(), "upgradepilot-baseline-"));
  const repoDir = join(workdir, "repo");
  const clone = await run("git", ["clone", "--depth", "1", repositoryUrl, repoDir], { cwd: workdir });

  const result = {
    overallStatus: "FAILED",
    runtime: {
      node: process.version,
      npm: null,
      pnpm: null,
      requiredNode: null,
      packageManager: null,
      hasPackageLock: false,
      lockfileVersion: null
    },
    package: {
      name: null,
      scripts: {},
      discoveredScripts: [],
      skippedScripts: verificationScriptOrder
    },
    commands: [clone]
  };

  const npmVersion = await run("npm", ["--version"], { cwd: workdir });
  result.runtime.npm = npmVersion.output;
  if (scriptRunner === "pnpm") {
    const pnpmVersion = await run("pnpm", ["--version"], { cwd: workdir });
    result.runtime.pnpm = pnpmVersion.output;
  }

  if (clone.exitCode !== 0) {
    printResult(result);
    return;
  }

  const packageJsonPath = join(repoDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    result.commands.push({
      command: "inspect package.json",
      exitCode: 1,
      durationMs: 0,
      output: "package.json was not found at the repository root."
    });
    printResult(result);
    return;
  }

  const packageJson = readJson(packageJsonPath);
  const packageLockPath = join(repoDir, "package-lock.json");
  result.package.name = typeof packageJson.name === "string" ? packageJson.name : null;
  result.package.scripts =
    packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  result.runtime.requiredNode =
    packageJson.engines && typeof packageJson.engines.node === "string"
      ? packageJson.engines.node
      : null;
  result.runtime.packageManager =
    typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
  result.runtime.hasPackageLock = existsSync(packageLockPath);
  if (result.runtime.hasPackageLock) {
    result.runtime.lockfileVersion = readJson(packageLockPath).lockfileVersion ?? null;
  }

  const install = await run(installCommand[0], installCommand.slice(1), { cwd: repoDir });
  result.commands.push(install);

  if (install.exitCode === 0) {
    result.package.discoveredScripts = verificationScriptOrder.filter(
      (scriptName) => result.package.scripts[scriptName] !== undefined
    );
    result.package.skippedScripts = verificationScriptOrder.filter(
      (scriptName) => result.package.scripts[scriptName] === undefined
    );

    for (const scriptName of result.package.discoveredScripts) {
      result.commands.push(await run(scriptRunner, ["run", scriptName], { cwd: repoDir }));
    }
  }

  result.overallStatus = result.commands.every((commandResult) => commandResult.exitCode === 0)
    ? "PASSED"
    : "FAILED";
  printResult(result);
}

function printResult(result) {
  console.log("${UPGRADEPILOT_BASELINE_RESULT_MARKER}_START");
  console.log(JSON.stringify(result));
  console.log("${UPGRADEPILOT_BASELINE_RESULT_MARKER}_END");
}

main().catch((error) => {
  printResult({
    overallStatus: "FAILED",
    runtime: { node: process.version, npm: null },
    package: { name: null, scripts: {}, discoveredScripts: [], skippedScripts: verificationScriptOrder },
    commands: [
      {
        command: "upgradepilot baseline workflow",
        exitCode: 1,
        durationMs: 0,
        output: String(error && error.stack ? error.stack : error)
      }
    ]
  });
});
`.trim();
}

export function buildNpmBaselineTurnPrompt(
  repositoryUrl: string,
  packageManager: VerificationPackageManager = "npm"
): string {
  const script = buildNpmBaselineWorkflowScript(repositoryUrl, packageManager);

  return [
    "Run UpgradePilot npm baseline verification for this public GitHub repository:",
    repositoryUrl,
    "",
    "Use the sandbox tool flow exactly once to execute this deterministic Node.js script.",
    "Do not inspect files manually. Do not modify repository files. Do not retry failed commands.",
    "After the script finishes, return a JSON object with a single field named resultText containing the exact marker-delimited script output.",
    "",
    "Script:",
    "```javascript",
    script,
    "```"
  ].join("\n");
}
