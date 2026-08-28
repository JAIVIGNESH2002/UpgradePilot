import type { SandboxProvider, SandboxWorkspace } from "@/lib/baseline";
import {
  buildNpmBaselineTurnPrompt,
  UPGRADEPILOT_BASELINE_RESULT_MARKER
} from "@/lib/trueforge-baseline-workflow";
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
  data: Array<{
    type: string;
    content?: string | Array<{ type?: string; text?: string }> | null;
  }>;
  pagination?: {
    next_page_token?: string | null;
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

export class TrueForgeIntegrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrueForgeIntegrationError";
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
    const response = await this.fetchImpl(this.url("/api/v1/settings/sandbox-providers"), {
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
        throw new TrueForgeIntegrationError(`TrueForge turn failed: ${turn.data.state.message}`);
      }

      if (turn.data.state.status === "cancelled") {
        throw new TrueForgeIntegrationError(
          `TrueForge turn was cancelled: ${turn.data.state.reason}`
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
      `TrueForge baseline workflow timed out after ${timeoutMs}ms.`
    );
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
        const text = trueForgeContentToText(event.content);

        if (text) {
          texts.push(text);
        }
      }

      pageToken = response.pagination?.next_page_token;
    } while (pageToken);

    return texts;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
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
    const response = await this.fetchImpl(this.url(path), {
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
    return this.client.runNpmBaselineWorkflow(input);
  }
}

function normalizeBaseUrl(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
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

export function parseBaselineWorkflowResult(text: string): TrueForgeBaselineWorkflowResult {
  const wrapperPayload = parseResultTextWrapper(text);
  const markerPattern = new RegExp(
    `${UPGRADEPILOT_BASELINE_RESULT_MARKER}_START\\s*([\\s\\S]*?)\\s*${UPGRADEPILOT_BASELINE_RESULT_MARKER}_END`
  );
  const markerMatch = markerPattern.exec(text);
  const rawPayload = wrapperPayload ?? (markerMatch ? markerMatch[1] : null);

  if (!rawPayload) {
    throw new TrueForgeIntegrationError(
      "TrueForge baseline workflow output did not contain the UpgradePilot result markers."
    );
  }

  const parsed = JSON.parse(rawPayload) as Partial<TrueForgeBaselineWorkflowResult>;

  if (
    (parsed.overallStatus !== "PASSED" && parsed.overallStatus !== "FAILED") ||
    !Array.isArray(parsed.commands)
  ) {
    throw new TrueForgeIntegrationError(
      "TrueForge baseline workflow returned an invalid UpgradePilot result payload."
    );
  }

  return parsed as TrueForgeBaselineWorkflowResult;
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
