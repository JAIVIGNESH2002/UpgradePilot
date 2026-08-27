import type { SandboxProvider, SandboxWorkspace } from "@/lib/baseline";

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
}

function normalizeBaseUrl(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}
