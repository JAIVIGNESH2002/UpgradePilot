import type { SandboxProvider, SandboxWorkspace } from "@/lib/baseline";
import { GitHubClient, parseGitHubRepositoryUrl } from "@/lib/github";
import {
  buildNpmBaselineTurnPrompt,
  UPGRADEPILOT_BASELINE_RESULT_MARKER
} from "@/lib/trueforge-baseline-workflow";
import type {
  UpgradeRepairHandoffResult,
  UpgradeVerificationResult
} from "@/lib/upgrade-run-store";
import {
  listMissingVerificationScripts,
  truncateCommandOutput,
  type BaselineVerificationResult,
  type BaselineStatus,
  type CommandResult,
  type VerificationPackageManager,
  type VerificationScriptName
} from "@/lib/verification";

export type TrueForgeHealth = {
  status: string;
  version: string;
};

export type TrueForgeSandboxProviderStatus = {
  type: string;
  status: string;
  statusReason: string | null;
};

type TrueForgeClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

let nextRepairTurnAllowedAt = 0;
let repairTurnQueue = Promise.resolve();

type HealthResponse = {
  status: string;
  version: string;
};

type SandboxProviderResponse = {
  data: {
    manifest: {
      type: string;
    };
    status: string;
    status_reason: string | null;
  };
};

type OpenApiResponse = {
  paths?: Record<string, unknown>;
};

type ModelListResponse = {
  data: Array<{ name: string }>;
};

type SessionResponse = {
  data: {
    id: string;
  };
};

type TurnResponse = {
  data: {
    id: string;
    state: TurnState;
  };
};

type TurnState =
  | { status: "running" }
  | {
      status: "done";
      output: TrueForgeModelMessage | null;
      required_actions: unknown[];
    }
  | { status: "error"; message: string }
  | { status: "cancelled"; reason: string };

type TrueForgeModelMessage = {
  content?: string | Array<{ type?: string; text?: string }> | null;
};

type TurnEventsResponse = {
  data: Array<Record<string, unknown>>;
  pagination?: {
    next_page_token?: string | null;
  };
};

type NpmBaselineSandboxRunResponse = {
  data: {
    sandbox_id: string;
    command: string;
    exit_code: number;
    output: string;
    cleanup: {
      status: "deleted" | "retained" | "failed";
      error?: string;
    };
  };
};

type NpmUpgradeSandboxRunResponse = NpmBaselineSandboxRunResponse;

type NpmUpgradeRepairContextResponse = {
  data: {
    sandbox_id: string;
    command: string;
    exit_code: number;
    context: string;
  };
};

type TrueForgeBaselineWorkflowResult = {
  overallStatus: BaselineStatus;
  runtime?: {
    node?: string | null;
    npm?: string | null;
    requiredNode?: string | null;
    packageManager?: string | null;
    hasPackageLock?: boolean;
    lockfileVersion?: number | null;
  };
  package?: {
    skippedScripts?: VerificationScriptName[];
  };
  commands: CommandResult[];
};

type TrueForgeUpgradeWorkflowResult = {
  overallStatus: BaselineStatus;
  upgradeStatus: "VERIFIED" | "FAILED" | "BLOCKED";
  upgrade?: {
    modelRepairRequired?: boolean;
    runtimeChangeRequired?: boolean;
  };
  package?: {
    skippedScripts?: VerificationScriptName[];
  };
  changedFiles?: Array<{ path: string; content: string }>;
  commands: CommandResult[];
};

const UPGRADEPILOT_UPGRADE_RESULT_MARKER = "UPGRADEPILOT_UPGRADE_RESULT";
const DEFAULT_REPAIR_TURN_INTERVAL_MS = 15_000;
const DEFAULT_REPAIR_BACKOFF_MS = 20_000;

export class TrueForgeIntegrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrueForgeIntegrationError";
  }
}

class TrueForgeTurnExecutionError extends TrueForgeIntegrationError {
  readonly sessionId: string;
  readonly turnId: string;

  constructor(message: string, input: { sessionId: string; turnId: string; cause?: unknown }) {
    super(message, { cause: input.cause });
    this.sessionId = input.sessionId;
    this.turnId = input.turnId;
  }
}

export class TrueForgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TrueForgeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790"
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getHealth(): Promise<TrueForgeHealth> {
    return this.getJson<HealthResponse>("/healthz");
  }

  async getSandboxProviderStatus(): Promise<TrueForgeSandboxProviderStatus | null> {
    const response = await this.fetchTrueForge("/api/v1/settings/sandbox-providers", {
      cache: "no-store"
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new TrueForgeIntegrationError(
        `TrueForge returned ${response.status} while reading sandbox provider settings.`
      );
    }

    const body = (await response.json()) as SandboxProviderResponse;

    return {
      type: body.data.manifest.type,
      status: body.data.status,
      statusReason: body.data.status_reason
    };
  }

  async supportsDirectSandboxExecution(): Promise<boolean> {
    const openApi = await this.getJson<OpenApiResponse>("/api/v1/openapi.json");
    const paths = Object.keys(openApi.paths ?? {});

    return paths.some((path) => /sandbox/i.test(path) && /exec|command|workspace/i.test(path));
  }

  async getDefaultModelName(): Promise<string> {
    const configuredModel = process.env.TRUEFORGE_MODEL_NAME?.trim();

    if (configuredModel) {
      return configuredModel;
    }

    const models = await this.getJson<ModelListResponse>("/api/v1/models");
    const modelName =
      models.data.find((model) => /flash|(^|[-/])mini($|[-/])|small|lite/i.test(model.name))
        ?.name ?? models.data[0]?.name;

    if (!modelName) {
      throw new TrueForgeIntegrationError(
        "TrueForge is reachable, but no model is configured for the sandbox workflow turn."
      );
    }

    return modelName;
  }

  async runNpmBaselineWorkflow(input: {
    repositoryUrl: string;
    scripts: Record<string, string>;
    packageManager: VerificationPackageManager;
  }): Promise<BaselineVerificationResult> {
    const health = await this.getHealth();
    const sandboxProvider = await this.getSandboxProviderStatus();

    if (!sandboxProvider || sandboxProvider.status !== "ready") {
      throw new TrueForgeIntegrationError(
        sandboxProvider
          ? `TrueForge ${health.version} sandbox provider ${sandboxProvider.type} is ${sandboxProvider.status}: ${sandboxProvider.statusReason ?? "no reason provided"}.`
          : `TrueForge ${health.version} is reachable, but no sandbox provider is configured.`
      );
    }

    const modelName = await this.getDefaultModelName();
    const session = await this.postJson<SessionResponse>("/api/v1/sessions", {
      agent: {
        spec: {
          model: {
            name: modelName,
            params: {
              temperature: 0,
              reasoning_effort: process.env.TRUEFORGE_REASONING_EFFORT ?? "low",
              parallel_tool_calls: false
            }
          },
          instructions: [
            "You are the UpgradePilot npm baseline verification runner.",
            "Your only job is to invoke the sandbox tool flow for the deterministic workflow supplied by UpgradePilot and return its machine-readable result.",
            "Do not decide the install or verification command sequence yourself.",
            "Do not repair, edit, retry, or work around failures.",
            "Do not expose credentials. Public repository access must not require a token."
          ].join(" "),
          response_format: { type: "json_object" },
          config: {
            iteration_limit: readPositiveIntegerEnv("TRUEFORGE_ITERATION_LIMIT", 24),
            sandbox: { enabled: true, file_downloads: false },
            dynamic_sub_agents: { enabled: false },
            generative_ui: { enabled: false },
            ask_user_questions: { enabled: false }
          }
        }
      }
    });
    const turn = await this.postJson<TurnResponse>(
      `/api/v1/sessions/${encodeURIComponent(session.data.id)}/turns`,
      {
        input: [
          {
            type: "user.message",
            content: buildNpmBaselineTurnPrompt(input.repositoryUrl, input.packageManager)
          }
        ],
        previous_turn_id: "none",
        stream: false
      }
    );
    const completedTurn = await this.waitForTurn(session.data.id, turn.data.id);
    const workflowText = await this.extractTurnWorkflowText(session.data.id, completedTurn);
    const workflowResult = parseBaselineWorkflowResult(workflowText);

    return mapBaselineWorkflowResult(workflowResult, input.scripts);
  }

  async runNpmBaselineSandbox(input: {
    repositoryUrl: string;
    scripts: Record<string, string>;
    packageManager: VerificationPackageManager;
  }): Promise<BaselineVerificationResult> {
    const health = await this.getHealth();
    const sandboxProvider = await this.getSandboxProviderStatus();

    if (!sandboxProvider || sandboxProvider.status !== "ready") {
      throw new TrueForgeIntegrationError(
        sandboxProvider
          ? `TrueForge ${health.version} sandbox provider ${sandboxProvider.type} is ${sandboxProvider.status}: ${sandboxProvider.statusReason ?? "no reason provided"}.`
          : `TrueForge ${health.version} is reachable, but no sandbox provider is configured.`
      );
    }

    const run = await this.postJson<NpmBaselineSandboxRunResponse>(
      "/api/v1/sandboxes/npm-baseline-runs",
      {
        repository_url: input.repositoryUrl,
        package_manager: input.packageManager,
        timeout_seconds: readPositiveIntegerEnv("TRUEFORGE_BASELINE_TIMEOUT_SECONDS", 10 * 60)
      }
    );

    if (run.data.cleanup.status === "failed") {
      throw new TrueForgeIntegrationError(
        `TrueForge baseline sandbox cleanup failed: ${run.data.cleanup.error ?? "unknown cleanup error"}.`
      );
    }

    const workflowResult = parseBaselineWorkflowResult(run.data.output, {
      command: run.data.command,
      exitCode: run.data.exit_code
    });

    return mapBaselineWorkflowResult(workflowResult, input.scripts);
  }

  async runNpmUpgradeSandbox(input: {
    repositoryUrl: string;
    packageManager: VerificationPackageManager;
    packageName: string;
    targetVersion: string;
  }): Promise<UpgradeVerificationResult> {
    const health = await this.getHealth();
    const sandboxProvider = await this.getSandboxProviderStatus();

    if (!sandboxProvider || sandboxProvider.status !== "ready") {
      throw new TrueForgeIntegrationError(
        sandboxProvider
          ? `TrueForge ${health.version} sandbox provider ${sandboxProvider.type} is ${sandboxProvider.status}: ${sandboxProvider.statusReason ?? "no reason provided"}.`
          : `TrueForge ${health.version} is reachable, but no sandbox provider is configured.`
      );
    }

    const run = await this.postJson<NpmUpgradeSandboxRunResponse>(
      "/api/v1/sandboxes/npm-upgrade-runs",
      {
        repository_url: input.repositoryUrl,
        package_manager: input.packageManager,
        package_name: input.packageName,
        target_version: input.targetVersion,
        retain_failed_sandbox: true,
        timeout_seconds: readPositiveIntegerEnv("TRUEFORGE_UPGRADE_TIMEOUT_SECONDS", 10 * 60)
      }
    );

    if (run.data.cleanup.status === "failed") {
      throw new TrueForgeIntegrationError(
        `TrueForge upgrade sandbox cleanup failed: ${run.data.cleanup.error ?? "unknown cleanup error"}.`
      );
    }

    const workflowResult = parseUpgradeWorkflowResult(run.data.output, {
      command: run.data.command,
      exitCode: run.data.exit_code
    });

    return mapUpgradeWorkflowResult(workflowResult, {
      sandboxId: run.data.sandbox_id,
      cleanup: run.data.cleanup
    });
  }

  async cleanupNpmUpgradeSandbox(input: { sandboxId: string }): Promise<void> {
    const response = await this.postJson<{
      data: { cleanup: { status: "deleted" | "retained" | "failed"; error?: string } };
    }>(`/api/v1/sandboxes/npm-upgrade-runs/${encodeURIComponent(input.sandboxId)}/cleanup`, {});

    if (response.data.cleanup.status === "failed") {
      throw new TrueForgeIntegrationError(
        `TrueForge upgrade sandbox cleanup failed: ${response.data.cleanup.error ?? "unknown cleanup error"}.`
      );
    }
  }

  async runNpmUpgradeRepairHandoff(input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    verificationResult: UpgradeVerificationResult;
  }): Promise<UpgradeRepairHandoffResult> {
    const maxAttempts = readPositiveIntegerEnv("TRUEFORGE_REPAIR_MAX_ATTEMPTS", 2);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await waitForRepairTurnSlot(
          readNonNegativeIntegerEnv(
            "TRUEFORGE_REPAIR_MIN_INTERVAL_MS",
            DEFAULT_REPAIR_TURN_INTERVAL_MS
          )
        );

        return await this.createUpgradeRepairTurn(input);
      } catch (error) {
        lastError = error;

        if (!isRateLimitError(error) || attempt === maxAttempts) {
          break;
        }

        await sleep(
          readPositiveIntegerEnv("TRUEFORGE_REPAIR_BACKOFF_MS", DEFAULT_REPAIR_BACKOFF_MS)
        );
      }
    }

    return {
      status: "failed",
      summary:
        lastError instanceof Error
          ? `TrueForge repair agent handoff failed: ${lastError.message}`
          : "TrueForge repair agent handoff failed.",
      sessionId: lastError instanceof TrueForgeTurnExecutionError ? lastError.sessionId : null,
      turnId: lastError instanceof TrueForgeTurnExecutionError ? lastError.turnId : null,
      verificationResult: null
    };
  }

  private async createUpgradeRepairTurn(input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    verificationResult: UpgradeVerificationResult;
  }): Promise<UpgradeRepairHandoffResult> {
    if (!input.verificationResult.sandboxId) {
      return {
        status: "failed",
        summary:
          "TrueForge repair could not run because the failed upgrade sandbox was not retained.",
        sessionId: null,
        turnId: null,
        verificationResult: null
      };
    }

    const repairContext = await this.collectNpmUpgradeRepairContext({
      sandboxId: input.verificationResult.sandboxId,
      packageManager: packageManagerFromCommands(input.verificationResult.commands),
      packageName: input.packageName
    });
    const modelName = await this.getDefaultModelName();
    const session = await this.postJson<SessionResponse>("/api/v1/sessions", {
      agent: {
        spec: {
          model: {
            name: modelName,
            params: {
              temperature: 0,
              reasoning_effort: process.env.TRUEFORGE_REPAIR_REASONING_EFFORT ?? "low",
              parallel_tool_calls: false,
              tool_choice: "none",
              max_tokens: readPositiveIntegerEnv("TRUEFORGE_REPAIR_MAX_TOKENS", 2_400)
            }
          },
          instructions: [
            "You are the UpgradePilot dependency repair handoff agent.",
            "You receive deterministic verification evidence after an attempted dependency upgrade.",
            "Do not call tools, run commands, edit files, create pull requests, or claim a repair was applied.",
            "Answer immediately from the evidence in the user's message.",
            "Diagnose the likely compatibility issue from the provided evidence only.",
            "Return concise JSON with summary, likelyCause, nextRepairAction, and confidence."
          ].join(" "),
          response_format: { type: "json_object" },
          config: {
            iteration_limit: readIntegerEnvAtLeast("TRUEFORGE_REPAIR_ITERATION_LIMIT", 5, 5),
            sandbox: { enabled: false, file_downloads: false },
            dynamic_sub_agents: { enabled: false },
            generative_ui: { enabled: false },
            ask_user_questions: { enabled: false },
            current_date_time: { enabled: false }
          }
        }
      }
    });
    const turn = await this.postJson<TurnResponse>(
      `/api/v1/sessions/${encodeURIComponent(session.data.id)}/turns`,
      {
        input: [
          {
            type: "user.message",
            content: buildUpgradeRepairHandoffPrompt({ ...input, repairContext })
          }
        ],
        previous_turn_id: "none",
        stream: false
      }
    );
    let completedTurn: TurnResponse["data"];

    try {
      completedTurn = await this.waitForTurn(session.data.id, turn.data.id);
    } catch (error) {
      throw new TrueForgeTurnExecutionError(
        error instanceof Error ? error.message : "TrueForge repair turn failed.",
        {
          sessionId: session.data.id,
          turnId: turn.data.id,
          cause: error
        }
      );
    }

    const repairPatch = extractRepairPatch(completedTurn);

    if (
      !repairPatch.unifiedDiff &&
      repairPatch.fileReplacements.length === 0 &&
      repairPatch.textReplacements.length === 0
    ) {
      return {
        status: "failed",
        summary: repairPatch.summary,
        sessionId: session.data.id,
        turnId: turn.data.id,
        verificationResult: null
      };
    }

    const verificationResult = await this.verifyNpmUpgradeRepair({
      sandboxId: input.verificationResult.sandboxId,
      packageManager: packageManagerFromCommands(input.verificationResult.commands),
      unifiedDiff: repairPatch.unifiedDiff,
      fileReplacements: repairPatch.fileReplacements,
      textReplacements: repairPatch.textReplacements
    });
    const enrichedVerificationResult =
      verificationResult.status === "VERIFIED"
        ? await this.includeVerifiedRepairFiles({
            repositoryUrl: input.repositoryUrl,
            verificationResult,
            repairPatch
          })
        : verificationResult;

    return {
      status: "completed",
      summary: repairPatch.summary,
      sessionId: session.data.id,
      turnId: turn.data.id,
      verificationResult: enrichedVerificationResult
    };
  }

  private async includeVerifiedRepairFiles(input: {
    repositoryUrl: string;
    verificationResult: UpgradeVerificationResult;
    repairPatch: RepairPatch;
  }): Promise<UpgradeVerificationResult> {
    const changedFiles = [...(input.verificationResult.changedFiles ?? [])];
    const includedPaths = new Set(changedFiles.map((file) => file.path));

    for (const replacement of input.repairPatch.fileReplacements) {
      if (!includedPaths.has(replacement.path)) {
        changedFiles.push({ path: replacement.path, content: replacement.content });
        includedPaths.add(replacement.path);
      }
    }

    const missingTextReplacementPaths = [
      ...new Set(
        input.repairPatch.textReplacements
          .map((replacement) => replacement.path)
          .filter((path) => !includedPaths.has(path))
      )
    ];
    const missingUnifiedDiffPatches = input.repairPatch.unifiedDiff
      ? parseUnifiedDiffFilePatches(input.repairPatch.unifiedDiff).filter(
          (patch) => !includedPaths.has(patch.path)
        )
      : [];

    if (missingTextReplacementPaths.length === 0 && missingUnifiedDiffPatches.length === 0) {
      return { ...input.verificationResult, changedFiles };
    }

    try {
      const ref = parseGitHubRepositoryUrl(input.repositoryUrl);
      const github = new GitHubClient({
        token: process.env.GITHUB_TOKEN,
        fetchImpl: this.fetchImpl
      });
      const metadata = await github.getRepositoryMetadata(ref);

      for (const patch of missingUnifiedDiffPatches) {
        const originalContent =
          patch.isNewFile === true
            ? ""
            : await github.getRepositoryFileText(ref, patch.path, metadata.defaultBranch);

        if (originalContent === null) {
          continue;
        }

        const repairedContent = applyUnifiedDiffPatch(originalContent, patch);
        changedFiles.push({ path: patch.path, content: repairedContent });
        includedPaths.add(patch.path);
      }

      for (const path of missingTextReplacementPaths) {
        if (includedPaths.has(path)) {
          continue;
        }

        const originalContent = await github.getRepositoryFileText(
          ref,
          path,
          metadata.defaultBranch
        );

        if (originalContent === null) {
          continue;
        }

        const repairedContent = applyRepairTextReplacements(
          originalContent,
          input.repairPatch.textReplacements.filter((replacement) => replacement.path === path)
        );

        if (repairedContent !== originalContent) {
          changedFiles.push({ path, content: repairedContent });
          includedPaths.add(path);
        }
      }
    } catch {
      return { ...input.verificationResult, changedFiles };
    }

    return { ...input.verificationResult, changedFiles };
  }

  private async collectNpmUpgradeRepairContext(input: {
    sandboxId: string;
    packageManager: VerificationPackageManager;
    packageName: string;
  }): Promise<string> {
    const response = await this.postJson<NpmUpgradeRepairContextResponse>(
      `/api/v1/sandboxes/npm-upgrade-runs/${encodeURIComponent(input.sandboxId)}/repair-context`,
      {
        package_manager: input.packageManager,
        package_name: input.packageName,
        timeout_seconds: readPositiveIntegerEnv("TRUEFORGE_REPAIR_CONTEXT_TIMEOUT_SECONDS", 120)
      }
    );

    if (response.data.exit_code !== 0) {
      throw new TrueForgeIntegrationError(
        `TrueForge repair context collection failed: ${response.data.context}`
      );
    }

    return response.data.context;
  }

  private async verifyNpmUpgradeRepair(input: {
    sandboxId: string;
    packageManager: VerificationPackageManager;
    unifiedDiff: string | null;
    fileReplacements: RepairFileReplacement[];
    textReplacements: RepairTextReplacement[];
  }): Promise<UpgradeVerificationResult> {
    const response = await this.postJson<NpmUpgradeSandboxRunResponse>(
      `/api/v1/sandboxes/npm-upgrade-runs/${encodeURIComponent(input.sandboxId)}/repair-verifications`,
      {
        package_manager: input.packageManager,
        ...(input.textReplacements.length > 0
          ? { text_replacements: input.textReplacements }
          : input.fileReplacements.length > 0
            ? { file_replacements: input.fileReplacements }
            : { unified_diff: input.unifiedDiff }),
        timeout_seconds: readPositiveIntegerEnv("TRUEFORGE_REPAIR_VERIFY_TIMEOUT_SECONDS", 10 * 60)
      }
    );
    const workflowResult = parseUpgradeWorkflowResult(response.data.output, {
      command: response.data.command,
      exitCode: response.data.exit_code
    });

    return mapUpgradeWorkflowResult(workflowResult, {
      sandboxId: response.data.sandbox_id,
      cleanup: response.data.cleanup
    });
  }

  private async waitForTurn(sessionId: string, turnId: string): Promise<TurnResponse["data"]> {
    const timeoutMs = Number(process.env.TRUEFORGE_TURN_TIMEOUT_MS ?? 10 * 60 * 1000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const turn = await this.getJson<TurnResponse>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`
      );

      if (turn.data.state.status === "running") {
        await sleep(2000);
        continue;
      }

      if (turn.data.state.status === "error") {
        throw new TrueForgeIntegrationError(
          await this.describeTerminalTurnFailure({
            sessionId,
            turnId,
            message: `TrueForge turn failed: ${turn.data.state.message}`
          })
        );
      }

      if (turn.data.state.status === "cancelled") {
        throw new TrueForgeIntegrationError(
          await this.describeTerminalTurnFailure({
            sessionId,
            turnId,
            message: `TrueForge turn was cancelled: ${turn.data.state.reason}`
          })
        );
      }

      if (turn.data.state.required_actions.length > 0) {
        throw new TrueForgeIntegrationError(
          "TrueForge baseline workflow paused for an action, which is not expected for deterministic verification."
        );
      }

      return turn.data;
    }

    throw new TrueForgeIntegrationError(
      await this.describeTerminalTurnFailure({
        sessionId,
        turnId,
        message: `TrueForge baseline workflow timed out after ${timeoutMs}ms.`
      })
    );
  }

  private async describeTerminalTurnFailure(input: {
    sessionId: string;
    turnId: string;
    message: string;
  }): Promise<string> {
    const eventDiagnostics = await this.listTurnEventDiagnostics(input.sessionId, input.turnId);
    const recentEvents = eventDiagnostics.slice(-8);

    if (recentEvents.length === 0) {
      return input.message;
    }

    return [
      input.message,
      "Recent TrueForge turn events:",
      truncateCommandOutput(recentEvents.join("\n"), 4000)
    ].join("\n");
  }

  private async extractTurnWorkflowText(
    sessionId: string,
    turn: TurnResponse["data"]
  ): Promise<string> {
    if (turn.state.status === "done") {
      const outputText = trueForgeContentToText(turn.state.output?.content);

      if (outputText.includes(UPGRADEPILOT_BASELINE_RESULT_MARKER)) {
        return outputText;
      }
    }

    const eventTexts = await this.listTurnEventTexts(sessionId, turn.id);
    const markedEventText = eventTexts.find((text) =>
      text.includes(UPGRADEPILOT_BASELINE_RESULT_MARKER)
    );

    if (markedEventText) {
      return markedEventText;
    }

    throw new TrueForgeIntegrationError(
      "TrueForge completed the baseline turn without returning the structured UpgradePilot result."
    );
  }

  private async listTurnEventTexts(sessionId: string, turnId: string): Promise<string[]> {
    const diagnostics = await this.listTurnEventDiagnostics(sessionId, turnId);

    return diagnostics
      .map((diagnostic) => diagnostic.replace(/^\[[^\]]+\]\s*/, ""))
      .filter(Boolean);
  }

  private async listTurnEventDiagnostics(sessionId: string, turnId: string): Promise<string[]> {
    const texts: string[] = [];
    let pageToken: string | null | undefined;

    do {
      const query = pageToken
        ? `?limit=100&page_token=${encodeURIComponent(pageToken)}`
        : "?limit=100";
      const response = await this.getJson<TurnEventsResponse>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events${query}`
      );

      for (const event of response.data) {
        const text = formatTurnEventDiagnostic(event);

        if (text) {
          texts.push(text);
        }
      }

      pageToken = response.pagination?.next_page_token;
    } while (pageToken);

    return texts;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchTrueForge(path, {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new TrueForgeIntegrationError(`TrueForge returned ${response.status} for ${path}.`);
    }

    return response.json() as Promise<T>;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchTrueForge(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new TrueForgeIntegrationError(
        `TrueForge returned ${response.status} for ${path}: ${await readResponseError(response)}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async fetchTrueForge(path: string, init: RequestInit): Promise<Response> {
    const primaryUrl = this.url(path);

    try {
      return await this.fetchImpl(primaryUrl, init);
    } catch (error) {
      const fallbackUrl = localhostFallbackUrl(primaryUrl);

      if (fallbackUrl !== null) {
        try {
          return await this.fetchImpl(fallbackUrl, init);
        } catch (fallbackError) {
          throw new TrueForgeIntegrationError(
            describeTrueForgeNetworkFailure(fallbackError, this.baseUrl),
            { cause: fallbackError }
          );
        }
      }

      throw new TrueForgeIntegrationError(describeTrueForgeNetworkFailure(error, this.baseUrl), {
        cause: error
      });
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

export class TrueForgeSandboxProvider implements SandboxProvider {
  private readonly client: TrueForgeClient;

  constructor(client = new TrueForgeClient()) {
    this.client = client;
  }

  async createWorkspace(input: { repositoryUrl: string }): Promise<SandboxWorkspace> {
    const health = await this.client.getHealth();
    const sandboxProvider = await this.client.getSandboxProviderStatus();
    const supportsDirectSandboxExecution = await this.client.supportsDirectSandboxExecution();

    if (!supportsDirectSandboxExecution) {
      throw new TrueForgeIntegrationError(
        [
          `TrueForge ${health.version} is reachable at TRUEFORGE_BASE_URL, but its OpenAPI contract does not expose direct deterministic sandbox execution.`,
          sandboxProvider
            ? `Configured sandbox provider: ${sandboxProvider.type} (${sandboxProvider.status}).`
            : "No sandbox provider is configured.",
          `Repository requested for baseline: ${input.repositoryUrl}.`,
          "The exposed contract supports agent sessions and sandbox file downloads, which would require an LLM turn for command orchestration. UpgradePilot will not use that path for baseline verification."
        ].join(" ")
      );
    }

    throw new TrueForgeIntegrationError(
      "Direct TrueForge sandbox execution was detected but is not implemented in this adapter yet."
    );
  }

  async runBaseline(input: {
    repositoryUrl: string;
    scripts: Record<string, string>;
    packageManager: VerificationPackageManager;
  }): Promise<BaselineVerificationResult> {
    return this.client.runNpmBaselineSandbox(input);
  }

  async runUpgrade(input: {
    repositoryUrl: string;
    packageManager: VerificationPackageManager;
    packageName: string;
    targetVersion: string;
  }): Promise<UpgradeVerificationResult> {
    return this.client.runNpmUpgradeSandbox(input);
  }

  async runUpgradeRepairHandoff(input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    verificationResult: UpgradeVerificationResult;
  }): Promise<UpgradeRepairHandoffResult> {
    return this.client.runNpmUpgradeRepairHandoff(input);
  }

  async cleanupUpgradeSandbox(input: { sandboxId: string }): Promise<void> {
    return this.client.cleanupNpmUpgradeSandbox(input);
  }
}

function normalizeBaseUrl(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function localhostFallbackUrl(input: string): string | null {
  const url = new URL(input);

  if (url.hostname !== "localhost") {
    return null;
  }

  url.hostname = "127.0.0.1";

  return url.toString();
}

function describeTrueForgeNetworkFailure(error: unknown, baseUrl: string): string {
  const causeCode = networkCauseCode(error);

  if (causeCode === "EACCES") {
    return `The UpgradePilot server could not reach TrueForge at TRUEFORGE_BASE_URL (${baseUrl}) because local network access is blocked for this process.`;
  }

  if (causeCode === "ECONNREFUSED") {
    return `TrueForge is not reachable at TRUEFORGE_BASE_URL (${baseUrl}). Confirm the patched TrueForge service is running and listening on that URL.`;
  }

  if (causeCode === "ENOTFOUND") {
    return `The UpgradePilot server could not resolve TRUEFORGE_BASE_URL (${baseUrl}). Check the configured host name.`;
  }

  if (causeCode === "ETIMEDOUT") {
    return `The UpgradePilot server timed out while connecting to TrueForge at TRUEFORGE_BASE_URL (${baseUrl}).`;
  }

  return error instanceof Error
    ? `The UpgradePilot server could not fetch data from TrueForge at TRUEFORGE_BASE_URL (${baseUrl}): ${error.message}.`
    : `The UpgradePilot server could not fetch data from TrueForge at TRUEFORGE_BASE_URL (${baseUrl}).`;
}

function networkCauseCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  if ("code" in error && error.code !== undefined) {
    return String(error.code);
  }

  const cause = error.cause;

  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return String(cause.code);
  }

  return undefined;
}

function mapBaselineWorkflowResult(
  result: TrueForgeBaselineWorkflowResult,
  scripts: Record<string, string>
): BaselineVerificationResult {
  const install = result.commands.find(
    (command) =>
      command.command === "npm ci" || command.command === "pnpm install --frozen-lockfile"
  );

  if (!install) {
    throw new TrueForgeIntegrationError(
      "TrueForge baseline workflow did not include the required package-manager install command result."
    );
  }

  const verification = result.commands.filter(
    (command) => command.command.startsWith("npm run ") || command.command.startsWith("pnpm run ")
  );

  return {
    status: result.overallStatus,
    install: normalizeCommandResult(install),
    verification: verification.map(normalizeCommandResult),
    skippedScripts: result.package?.skippedScripts ?? listMissingVerificationScripts(scripts)
  };
}

export function parseBaselineWorkflowResult(
  text: string,
  context?: { command?: string; exitCode?: number }
): TrueForgeBaselineWorkflowResult {
  const wrapperPayload = parseResultTextWrapper(text);
  const markerPattern = new RegExp(
    `${UPGRADEPILOT_BASELINE_RESULT_MARKER}_START\\s*([\\s\\S]*?)\\s*${UPGRADEPILOT_BASELINE_RESULT_MARKER}_END`
  );
  const markerMatch = markerPattern.exec(text);
  const rawPayload = wrapperPayload ?? (markerMatch ? markerMatch[1] : null);

  if (!rawPayload) {
    throw new TrueForgeIntegrationError(describeMissingBaselineMarkers(text, context));
  }

  const parsed = JSON.parse(rawPayload) as Partial<TrueForgeBaselineWorkflowResult>;

  if (
    (parsed.overallStatus !== "PASSED" &&
      parsed.overallStatus !== "FAILED" &&
      parsed.overallStatus !== "BLOCKED") ||
    !Array.isArray(parsed.commands)
  ) {
    throw new TrueForgeIntegrationError(
      "TrueForge baseline workflow returned an invalid UpgradePilot result payload."
    );
  }

  return parsed as TrueForgeBaselineWorkflowResult;
}

export function parseUpgradeWorkflowResult(
  text: string,
  context?: { command?: string; exitCode?: number }
): TrueForgeUpgradeWorkflowResult {
  const markerPattern = new RegExp(
    `${UPGRADEPILOT_UPGRADE_RESULT_MARKER}_START\\s*([\\s\\S]*?)\\s*${UPGRADEPILOT_UPGRADE_RESULT_MARKER}_END`
  );
  const rawPayload = markerPattern.exec(text)?.[1] ?? null;

  if (!rawPayload) {
    throw new TrueForgeIntegrationError(
      describeMissingWorkflowMarkers({
        text,
        context,
        workflow: "upgrade",
        marker: "UPGRADEPILOT_UPGRADE_RESULT"
      })
    );
  }

  const parsed = JSON.parse(rawPayload) as Partial<TrueForgeUpgradeWorkflowResult>;

  if (
    (parsed.upgradeStatus !== "VERIFIED" &&
      parsed.upgradeStatus !== "FAILED" &&
      parsed.upgradeStatus !== "BLOCKED") ||
    !Array.isArray(parsed.commands)
  ) {
    throw new TrueForgeIntegrationError(
      "TrueForge upgrade workflow returned an invalid UpgradePilot result payload."
    );
  }

  return parsed as TrueForgeUpgradeWorkflowResult;
}

function describeMissingBaselineMarkers(
  text: string,
  context?: { command?: string; exitCode?: number }
): string {
  return describeMissingWorkflowMarkers({
    text,
    context,
    workflow: "baseline",
    marker: "UPGRADEPILOT_BASELINE_RESULT"
  });
}

function describeMissingWorkflowMarkers({
  text,
  context,
  workflow
}: {
  text: string;
  context?: { command?: string; exitCode?: number };
  workflow: "baseline" | "upgrade";
  marker: string;
}): string {
  const details = [
    `TrueForge ${workflow} workflow output did not contain the UpgradePilot result markers.`
  ];

  if (context?.command) {
    details.push(`Command: ${context.command}.`);
  }

  if (context?.exitCode !== undefined) {
    details.push(`Exit code: ${context.exitCode}.`);
  }

  const output = truncateCommandOutput(text.trim());

  if (output) {
    details.push(`Output: ${output}`);
  }

  return details.join(" ");
}

function mapUpgradeWorkflowResult(
  result: TrueForgeUpgradeWorkflowResult,
  lifecycle: {
    sandboxId: string | null;
    cleanup: UpgradeVerificationResult["cleanup"];
  } = { sandboxId: null, cleanup: null }
): UpgradeVerificationResult {
  return {
    status: result.upgradeStatus,
    commands: result.commands.map(normalizeCommandResult),
    skippedScripts: result.package?.skippedScripts ?? [],
    modelRepairRequired: result.upgrade?.modelRepairRequired ?? result.upgradeStatus === "FAILED",
    runtimeChangeRequired:
      result.upgrade?.runtimeChangeRequired ?? result.upgradeStatus === "BLOCKED",
    sandboxId: lifecycle.sandboxId,
    cleanup: lifecycle.cleanup,
    changedFiles: Array.isArray(result.changedFiles)
      ? result.changedFiles.filter(
          (file): file is { path: string; content: string } =>
            typeof file.path === "string" && typeof file.content === "string"
        )
      : []
  };
}

function buildUpgradeRepairHandoffPrompt(input: {
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  verificationResult: UpgradeVerificationResult;
  repairContext: string;
}): string {
  return JSON.stringify({
    task: "upgradepilot_dependency_repair",
    constraints: [
      "Do not run commands or use tools.",
      "Prefer textReplacements over fileReplacements and unifiedDiff for application-code compatibility fixes.",
      "For textReplacements, return short exact old_text/new_text edits using paths relative to the repository root. old_text must appear exactly once in repairContext.",
      "Use fileReplacements only if exact text replacement is unsafe. Use unifiedDiff only if neither structured edit format is practical.",
      "Do not wrap JSON, replacement content, text replacement strings, or unifiedDiff in Markdown fences.",
      "Do not weaken, skip, delete, or disable tests.",
      "Do not edit lockfiles, package.json dependency versions, CI config, or verification scripts.",
      "Only repair application/source/test code needed for compatibility with the target dependency.",
      "Do not decide routine verification steps; those were already executed deterministically.",
      "Application source code changes are expected in this step and must not be treated as blocked.",
      "Only block when the evidence points to a runtime/install requirement, missing source context, unsafe test weakening, or a change outside application/source/test code.",
      "Return only JSON."
    ],
    repository: {
      url: input.repositoryUrl
    },
    dependency: {
      name: input.packageName,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion
    },
    deterministicVerification: {
      status: input.verificationResult.status,
      runtimeChangeRequired: input.verificationResult.runtimeChangeRequired,
      modelRepairRequired: input.verificationResult.modelRepairRequired,
      skippedScripts: input.verificationResult.skippedScripts,
      commands: input.verificationResult.commands.map((command) => ({
        command: command.command,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        output: truncateCommandOutput(command.output, 1200)
      }))
    },
    repairContext: truncateCommandOutput(input.repairContext, 40_000),
    responseShape: {
      summary: "one concise sentence",
      likelyCause: "brief observed compatibility diagnosis",
      textReplacements: [
        {
          path: "relative/source/file/path.ts",
          old_text: "exact original text from repairContext",
          new_text: "replacement text"
        }
      ],
      fileReplacements: [
        {
          path: "relative/source/file/path.ts",
          content: "complete replacement file content"
        }
      ],
      unifiedDiff:
        "optional complete git-compatible unified diff; empty string when fileReplacements is provided or blocked",
      confidence: "low | medium | high",
      blockedReason:
        "only when no safe patch should be applied; never use this merely because application source code must change"
    }
  });
}

function extractRepairPatch(turn: TurnResponse["data"]): RepairPatch {
  if (turn.state.status !== "done") {
    return {
      summary: "TrueForge repair agent completed without a final response.",
      unifiedDiff: null,
      fileReplacements: [],
      textReplacements: []
    };
  }

  const text = trueForgeContentToText(turn.state.output?.content).trim();

  if (!text) {
    return {
      summary: "TrueForge repair agent completed without a final response.",
      unifiedDiff: null,
      fileReplacements: [],
      textReplacements: []
    };
  }

  try {
    const parsed = JSON.parse(stripJsonFence(text)) as {
      summary?: unknown;
      likelyCause?: unknown;
      unifiedDiff?: unknown;
      fileReplacements?: unknown;
      textReplacements?: unknown;
      blockedReason?: unknown;
    };
    const details = [
      typeof parsed.summary === "string" ? parsed.summary : null,
      typeof parsed.likelyCause === "string" ? `Likely cause: ${parsed.likelyCause}` : null,
      typeof parsed.blockedReason === "string" ? `Blocked: ${parsed.blockedReason}` : null
    ].filter(Boolean);
    const unifiedDiff = typeof parsed.unifiedDiff === "string" ? parsed.unifiedDiff.trim() : "";
    const textReplacements = parseRepairTextReplacements(parsed.textReplacements);
    const fileReplacements = parseRepairFileReplacements(parsed.fileReplacements);

    return {
      summary:
        details.length > 0
          ? truncateCommandOutput(details.join("\n"))
          : truncateCommandOutput(text),
      unifiedDiff: unifiedDiff === "" ? null : unifiedDiff,
      fileReplacements,
      textReplacements
    };
  } catch {
    return {
      summary: truncateCommandOutput(text),
      unifiedDiff: null,
      fileReplacements: [],
      textReplacements: []
    };
  }
}

type RepairFileReplacement = {
  path: string;
  content: string;
};

type RepairPatch = {
  summary: string;
  unifiedDiff: string | null;
  fileReplacements: RepairFileReplacement[];
  textReplacements: RepairTextReplacement[];
};

type RepairTextReplacement = {
  path: string;
  old_text: string;
  new_text: string;
};

type UnifiedDiffFilePatch = {
  path: string;
  isNewFile: boolean;
  hunks: Array<{
    oldStart: number;
    lines: Array<{ type: "context" | "add" | "remove"; content: string }>;
  }>;
};

function parseUnifiedDiffFilePatches(diff: string): UnifiedDiffFilePatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const patches: UnifiedDiffFilePatch[] = [];
  let current: UnifiedDiffFilePatch | null = null;

  for (const line of lines) {
    const diffMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);

    if (diffMatch) {
      current = { path: diffMatch[2] ?? diffMatch[1] ?? "", isNewFile: false, hunks: [] };
      patches.push(current);
      continue;
    }

    if (current === null) {
      continue;
    }

    if (line === "--- /dev/null") {
      current.isNewFile = true;
      continue;
    }

    const targetMatch = /^\+\+\+ b\/(.+)$/.exec(line);

    if (targetMatch) {
      current.path = targetMatch[1] ?? current.path;
      continue;
    }

    if (line === "+++ /dev/null" || line.startsWith("Binary files ")) {
      current.hunks = [];
      current.path = "";
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);

    if (hunkMatch) {
      current.hunks.push({
        oldStart: Number.parseInt(hunkMatch[1] ?? "1", 10),
        lines: []
      });
      continue;
    }

    const hunk = current.hunks.at(-1);

    if (!hunk || line === "\\ No newline at end of file") {
      continue;
    }

    if (line.startsWith(" ")) {
      hunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "remove", content: line.slice(1) });
    }
  }

  return patches.filter((patch) => patch.path !== "" && patch.hunks.length > 0);
}

function applyUnifiedDiffPatch(content: string, patch: UnifiedDiffFilePatch): string {
  const hasTrailingNewline = content.endsWith("\n");
  const originalLines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);

    output.push(...originalLines.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      if (line.type === "add") {
        output.push(line.content);
        continue;
      }

      if (originalLines[cursor] !== line.content) {
        throw new TrueForgeIntegrationError(
          `Verified repair diff no longer applies cleanly to ${patch.path}.`
        );
      }

      if (line.type === "context") {
        output.push(line.content);
      }

      cursor += 1;
    }
  }

  output.push(...originalLines.slice(cursor));

  return output.join("\n") + (hasTrailingNewline || patch.isNewFile ? "\n" : "");
}

function parseRepairTextReplacements(value: unknown): RepairTextReplacement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { path?: unknown }).path === "string" &&
        typeof (item as { old_text?: unknown }).old_text === "string" &&
        typeof (item as { new_text?: unknown }).new_text === "string"
      ) {
        return {
          path: (item as { path: string }).path,
          old_text: (item as { old_text: string }).old_text,
          new_text: (item as { new_text: string }).new_text
        };
      }
      return null;
    })
    .filter((item): item is RepairTextReplacement => item !== null);
}

function applyRepairTextReplacements(
  content: string,
  replacements: RepairTextReplacement[]
): string {
  let nextContent = content;

  for (const replacement of replacements) {
    const firstIndex = nextContent.indexOf(replacement.old_text);

    if (firstIndex === -1 || nextContent.indexOf(replacement.old_text, firstIndex + 1) !== -1) {
      continue;
    }

    nextContent = nextContent.replace(replacement.old_text, replacement.new_text);
  }

  return nextContent;
}

function parseRepairFileReplacements(value: unknown): RepairFileReplacement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { path?: unknown }).path === "string" &&
        typeof (item as { content?: unknown }).content === "string"
      ) {
        return {
          path: (item as { path: string }).path,
          content: (item as { content: string }).content
        };
      }
      return null;
    })
    .filter((item): item is RepairFileReplacement => item !== null);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);

  return match?.[1] ? match[1].trim() : trimmed;
}

function packageManagerFromCommands(commands: CommandResult[]): VerificationPackageManager {
  return commands.some((command) => command.command.startsWith("pnpm ")) ? "pnpm" : "npm";
}

function formatTurnEventDiagnostic(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "event";

  if (type === "turn.created") {
    return "[turn.created] Turn started.";
  }

  if (type === "turn.done") {
    const state = readObject(event.state);
    const status = typeof state?.status === "string" ? state.status : "unknown";
    const message =
      readString(state?.message) ?? readString(state?.reason) ?? readString(state?.error);

    return `[turn.done] ${message ? `${status}: ${message}` : status}`;
  }

  if (type === "model.message") {
    const text = trueForgeContentToText(event.content as TrueForgeModelMessage["content"]).trim();
    const finishReason = readString(event.finish_reason);
    const usage = formatModelUsage(readObject(event.usage));
    const details = [text, finishReason ? `finish_reason=${finishReason}` : null, usage]
      .filter(Boolean)
      .join(" ");

    return details ? `[model.message] ${truncateCommandOutput(details, 1000)}` : "";
  }

  if (type === "tool.response") {
    const name = readString(event.name) ?? readString(event.tool_name) ?? "tool";
    const content = trueForgeContentToText(event.content as TrueForgeModelMessage["content"]);

    return `[tool.response] ${name}: ${truncateCommandOutput(content.trim(), 1000)}`;
  }

  if (type === "tool.response.required") {
    return "[tool.response.required] Agent requested tool responses.";
  }

  if (type === "tool.approval.required") {
    return "[tool.approval.required] Agent requested tool approval.";
  }

  if (type === "sandbox.created") {
    return "[sandbox.created] Sandbox was created.";
  }

  if (type === "mcp.initialize") {
    const serverName = readString(event.server_name) ?? readString(event.name);

    return `[mcp.initialize] ${serverName ?? "MCP server initialized"}`;
  }

  const content = trueForgeContentToText(event.content as TrueForgeModelMessage["content"]).trim();

  if (content) {
    return `[${type}] ${truncateCommandOutput(content, 1000)}`;
  }

  return `[${type}] ${truncateCommandOutput(JSON.stringify(redactDiagnosticEvent(event)), 1000)}`;
}

function formatModelUsage(usage: Record<string, unknown> | null): string | null {
  if (!usage) {
    return null;
  }

  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);

  if (inputTokens === null && outputTokens === null) {
    return null;
  }

  return `tokens=${inputTokens ?? "?"}/${outputTokens ?? "?"}`;
}

function redactDiagnosticEvent(event: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    redacted[key] = /token|secret|key|authorization|password/i.test(key) ? "[redacted]" : value;
  }

  return redacted;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function waitForRepairTurnSlot(minIntervalMs: number): Promise<void> {
  const queuedTurn = repairTurnQueue.then(async () => {
    const waitMs = Math.max(0, nextRepairTurnAllowedAt - Date.now());

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    nextRepairTurnAllowedAt = Date.now() + minIntervalMs;
  });

  repairTurnQueue = queuedTurn.catch(() => undefined);

  await queuedTurn;
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /429|rate.?limit|quota|resource_exhausted/i.test(message);
}

function parseResultTextWrapper(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { resultText?: unknown };

    return typeof parsed.resultText === "string" ? parseMarkerPayload(parsed.resultText) : null;
  } catch {
    return null;
  }
}

function parseMarkerPayload(text: string): string | null {
  const markerPattern = new RegExp(
    `${UPGRADEPILOT_BASELINE_RESULT_MARKER}_START\\s*([\\s\\S]*?)\\s*${UPGRADEPILOT_BASELINE_RESULT_MARKER}_END`
  );

  return markerPattern.exec(text)?.[1] ?? null;
}

function normalizeCommandResult(command: CommandResult): CommandResult {
  return {
    command: command.command,
    exitCode: Number.isInteger(command.exitCode) ? command.exitCode : 1,
    durationMs: Number.isFinite(command.durationMs)
      ? Math.max(0, Math.round(command.durationMs))
      : 0,
    output: truncateCommandOutput(String(command.output ?? ""))
  };
}

function trueForgeContentToText(content: TrueForgeModelMessage["content"] | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }

  return "";
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };

    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readIntegerEnvAtLeast(name: string, fallback: number, minimum: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);

  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
