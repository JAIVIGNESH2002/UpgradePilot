import type { SandboxProvider, SandboxWorkspace } from "@/lib/baseline";
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
      status: "deleted" | "failed";
      error?: string;
    };
  };
};

type NpmUpgradeSandboxRunResponse = NpmBaselineSandboxRunResponse;

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

    return mapUpgradeWorkflowResult(workflowResult);
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
      turnId: lastError instanceof TrueForgeTurnExecutionError ? lastError.turnId : null
    };
  }

  private async createUpgradeRepairTurn(input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    verificationResult: UpgradeVerificationResult;
  }): Promise<UpgradeRepairHandoffResult> {
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
              max_tokens: readPositiveIntegerEnv("TRUEFORGE_REPAIR_MAX_TOKENS", 800)
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
            content: buildUpgradeRepairHandoffPrompt(input)
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

    const summary = extractRepairSummary(completedTurn);

    return {
      status: "completed",
      summary,
      sessionId: session.data.id,
      turnId: turn.data.id
    };
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
  result: TrueForgeUpgradeWorkflowResult
): UpgradeVerificationResult {
  return {
    status: result.upgradeStatus,
    commands: result.commands.map(normalizeCommandResult),
    skippedScripts: result.package?.skippedScripts ?? [],
    modelRepairRequired: result.upgrade?.modelRepairRequired ?? result.upgradeStatus === "FAILED",
    runtimeChangeRequired:
      result.upgrade?.runtimeChangeRequired ?? result.upgradeStatus === "BLOCKED"
  };
}

function buildUpgradeRepairHandoffPrompt(input: {
  repositoryUrl: string;
  packageName: string;
  currentVersion: string;
  targetVersion: string;
  verificationResult: UpgradeVerificationResult;
}): string {
  return JSON.stringify({
    task: "upgradepilot_dependency_repair_handoff",
    constraints: [
      "Do not run commands or use tools.",
      "Do not claim repository files were changed.",
      "Do not decide routine verification steps; those were already executed deterministically.",
      "If the evidence points to a runtime/install requirement, mark the next action as blocked.",
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
    responseShape: {
      summary: "one concise sentence",
      likelyCause: "brief observed compatibility diagnosis",
      nextRepairAction: "specific next repair action for a future repair implementation",
      confidence: "low | medium | high"
    }
  });
}

function extractRepairSummary(turn: TurnResponse["data"]): string {
  if (turn.state.status !== "done") {
    return "TrueForge repair agent handoff completed without a final response.";
  }

  const text = trueForgeContentToText(turn.state.output?.content).trim();

  if (!text) {
    return "TrueForge repair agent handoff completed without a final response.";
  }

  try {
    const parsed = JSON.parse(text) as {
      summary?: unknown;
      likelyCause?: unknown;
      nextRepairAction?: unknown;
    };
    const details = [
      typeof parsed.summary === "string" ? parsed.summary : null,
      typeof parsed.likelyCause === "string" ? `Likely cause: ${parsed.likelyCause}` : null,
      typeof parsed.nextRepairAction === "string"
        ? `Next repair action: ${parsed.nextRepairAction}`
        : null
    ].filter(Boolean);

    return details.length > 0
      ? truncateCommandOutput(details.join("\n"))
      : truncateCommandOutput(text);
  } catch {
    return truncateCommandOutput(text);
  }
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
