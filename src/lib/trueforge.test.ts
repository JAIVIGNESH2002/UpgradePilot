import { afterEach, describe, expect, it, vi } from "vitest";

import { clearGitHubCachesForTests } from "@/lib/github";
import {
  TrueForgeClient,
  TrueForgeIntegrationError,
  TrueForgeSandboxProvider,
  parseBaselineWorkflowResult,
  parseUpgradeWorkflowResult
} from "@/lib/trueforge";

describe("TrueForgeClient", () => {
  afterEach(() => {
    clearGitHubCachesForTests();
    vi.unstubAllEnvs();
  });

  it("reads health and sandbox provider status from the confirmed API contract", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href === "http://trueforge.test/healthz") {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href === "http://trueforge.test/api/v1/settings/sandbox-providers") {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      return Response.json({ paths: {} });
    });

    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test/",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.getHealth()).resolves.toEqual({
      status: "ok",
      version: "0.2.0-rc.0"
    });
    await expect(client.getSandboxProviderStatus()).resolves.toEqual({
      type: "daytona",
      status: "ready",
      statusReason: null
    });
  });

  it("detects direct sandbox execution paths only when the OpenAPI exposes them", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        paths: {
          "/api/v1/sessions": {},
          "/api/v1/sandboxes/{sandbox_id}/exec": {}
        }
      })
    );

    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.supportsDirectSandboxExecution()).resolves.toBe(true);
  });

  it("prefers a lighter configured model without treating gemini as mini", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [
          { name: "google-gemini/gemini-3-1-pro-preview" },
          { name: "google-gemini/gemini-3-6-flash" }
        ]
      })
    );
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.getDefaultModelName()).resolves.toBe("google-gemini/gemini-3-6-flash");
  });

  it("retries localhost requests against 127.0.0.1 when the first connection fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href === "http://localhost:8790/healthz") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" }
        });
      }

      if (href === "http://127.0.0.1:8790/healthz") {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://localhost:8790",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.getHealth()).resolves.toEqual({
      status: "ok",
      version: "0.2.0-rc.0"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8790/healthz",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("reports refused TrueForge connections with setup guidance", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" }
      });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://localhost:8790",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.getHealth()).rejects.toThrow(
      "TrueForge is not reachable at TRUEFORGE_BASE_URL (http://localhost:8790)."
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("applies the configured TrueForge request timeout", async () => {
    vi.stubEnv("TRUEFORGE_REQUEST_TIMEOUT_MS", "5");
    let observedAbortSignal = false;
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          observedAbortSignal = signal instanceof AbortSignal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true }
          );
        })
    );
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(client.getHealth()).rejects.toThrow(
      "The UpgradePilot server could not fetch data from TrueForge"
    );
    expect(observedAbortSignal).toBe(true);
  });

  it("creates a constrained repair turn, applies the patch, and verifies again", async () => {
    vi.stubEnv("TRUEFORGE_REPAIR_MIN_INTERVAL_MS", "0");
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: href, body });

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-context")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-context.sh",
            exit_code: 0,
            context: "--- src/lib/validation.ts\nz.string({ required_error: 'Required' })"
          }
        });
      }

      if (href.endsWith("/api/v1/models")) {
        return Response.json({ data: [{ name: "google-gemini/gemini-3-6-flash" }] });
      }

      if (href === "https://api.github.com/repos/acme/demo") {
        return Response.json({
          name: "demo",
          full_name: "acme/demo",
          owner: { login: "acme" },
          private: false,
          html_url: "https://github.com/acme/demo",
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-30T00:00:00Z"
        });
      }

      if (
        href === "https://api.github.com/repos/acme/demo/contents/src/lib/validation.ts?ref=main"
      ) {
        return new Response("export const schema = z.string({ required_error: 'Required' });\n");
      }

      if (href.endsWith("/api/v1/sessions") && method === "POST") {
        return Response.json({ data: { id: "session-1" } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns") && method === "POST") {
        return Response.json({
          data: {
            id: "turn-1",
            state: { status: "running" }
          }
        });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns/turn-1")) {
        return Response.json({
          data: {
            id: "turn-1",
            state: {
              status: "done",
              output: {
                content: JSON.stringify({
                  summary: "The upgrade appears to require an API migration.",
                  likelyCause: "A removed API is still imported.",
                  textReplacements: [
                    {
                      path: "src/lib/validation.ts",
                      old_text: "z.string({ required_error: 'Required' })",
                      new_text: "z.string().min(1, 'Required')"
                    }
                  ],
                  fileReplacements: [],
                  unifiedDiff: ""
                })
              },
              required_actions: []
            }
          }
        });
      }

      if (
        href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-verifications")
      ) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-verify.sh",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_UPGRADE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                upgradeStatus: "VERIFIED",
                upgrade: { modelRepairRequired: false, runtimeChangeRequired: false },
                commands: [
                  {
                    command: "apply structured repair file replacements",
                    exitCode: 0,
                    durationMs: 1,
                    output: "Applied 1 file replacement(s)."
                  },
                  { command: "npm ci", exitCode: 0, durationMs: 2, output: "installed" },
                  { command: "npm run typecheck", exitCode: 0, durationMs: 3, output: "ok" }
                ]
              }),
              "UPGRADEPILOT_UPGRADE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "retained" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const result = await client.runNpmUpgradeRepairHandoff({
      repositoryUrl: "https://github.com/acme/demo",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      verificationResult: {
        status: "FAILED",
        commands: [
          { command: "npm install react@19.0.0", exitCode: 0, durationMs: 10, output: "ok" },
          { command: "npm run test", exitCode: 1, durationMs: 20, output: "removed API" }
        ],
        skippedScripts: [],
        modelRepairRequired: true,
        runtimeChangeRequired: false,
        sandboxId: "default.sandbox-1",
        cleanup: { status: "retained" }
      }
    });

    const sessionRequest = requests.find(
      (request) => request.url.endsWith("/api/v1/sessions") && request.method === "POST"
    );
    const turnRequest = requests.find(
      (request) =>
        request.url.endsWith("/api/v1/sessions/session-1/turns") && request.method === "POST"
    );

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "session-1",
      turnId: "turn-1",
      verificationResult: {
        status: "VERIFIED",
        changedFiles: [
          {
            path: "src/lib/validation.ts",
            content: "export const schema = z.string().min(1, 'Required');\n"
          }
        ]
      }
    });
    expect(result.summary).toContain("API migration");
    expect(
      requests.find((request) =>
        request.url.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-context")
      )?.body
    ).toMatchObject({ package_manager: "npm", package_name: "react" });
    expect(
      requests.find((request) =>
        request.url.endsWith(
          "/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-verifications"
        )
      )?.body
    ).toMatchObject({
      package_manager: "npm",
      text_replacements: [
        {
          path: "src/lib/validation.ts",
          old_text: expect.stringContaining("required_error"),
          new_text: expect.stringContaining("z.string().min")
        }
      ]
    });
    expect(sessionRequest?.body).toMatchObject({
      agent: {
        spec: {
          model: {
            name: "google-gemini/gemini-3-6-flash",
            params: {
              temperature: 0,
              parallel_tool_calls: false,
              tool_choice: "none"
            }
          },
          config: {
            iteration_limit: 5,
            sandbox: { enabled: false },
            dynamic_sub_agents: { enabled: false },
            generative_ui: { enabled: false },
            ask_user_questions: { enabled: false },
            current_date_time: { enabled: false }
          }
        }
      }
    });
    expect(JSON.stringify(turnRequest?.body)).toContain("Do not run commands or use tools.");
    expect(JSON.stringify(turnRequest?.body)).toContain(
      "Application source code changes are expected in this step"
    );
    expect(JSON.stringify(turnRequest?.body)).toContain("must not be treated as blocked");
    expect(JSON.stringify(turnRequest?.body)).toContain("Prefer textReplacements");
  });

  it("enriches verified unified diff repairs when changed files are incomplete", async () => {
    vi.stubEnv("TRUEFORGE_REPAIR_MIN_INTERVAL_MS", "0");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-context")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-context.sh",
            exit_code: 0,
            context: "--- src/lib/validation.ts\nexport const schema = z.string();"
          }
        });
      }

      if (href.endsWith("/api/v1/models")) {
        return Response.json({ data: [{ name: "google-gemini/gemini-3-6-flash" }] });
      }

      if (href.endsWith("/api/v1/sessions") && method === "POST") {
        return Response.json({ data: { id: "session-1" } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns") && method === "POST") {
        return Response.json({ data: { id: "turn-1", state: { status: "running" } } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns/turn-1")) {
        return Response.json({
          data: {
            id: "turn-1",
            state: {
              status: "done",
              output: {
                content: JSON.stringify({
                  summary: "Update validation for the new API.",
                  unifiedDiff: [
                    "diff --git a/src/lib/validation.ts b/src/lib/validation.ts",
                    "--- a/src/lib/validation.ts",
                    "+++ b/src/lib/validation.ts",
                    "@@ -1 +1 @@",
                    "-export const schema = z.string();",
                    "+export const schema = z.string().min(1);"
                  ].join("\n")
                })
              },
              required_actions: []
            }
          }
        });
      }

      if (
        href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-verifications")
      ) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-verify.sh",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_UPGRADE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                upgradeStatus: "VERIFIED",
                upgrade: { modelRepairRequired: false, runtimeChangeRequired: false },
                commands: [
                  { command: "npm run typecheck", exitCode: 0, durationMs: 3, output: "ok" }
                ]
              }),
              "UPGRADEPILOT_UPGRADE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "retained" }
          }
        });
      }

      if (href === "https://api.github.com/repos/acme/demo") {
        return Response.json({
          name: "demo",
          owner: { login: "acme" },
          private: false,
          html_url: "https://github.com/acme/demo",
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-30T00:00:00Z"
        });
      }

      if (
        href === "https://api.github.com/repos/acme/demo/contents/src/lib/validation.ts?ref=main"
      ) {
        return new Response("export const schema = z.string();\n");
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const result = await client.runNpmUpgradeRepairHandoff({
      repositoryUrl: "https://github.com/acme/demo",
      packageName: "zod",
      currentVersion: "3.25.0",
      targetVersion: "4.4.3",
      verificationResult: {
        status: "FAILED",
        commands: [{ command: "npm run typecheck", exitCode: 1, durationMs: 20, output: "failed" }],
        skippedScripts: [],
        modelRepairRequired: true,
        runtimeChangeRequired: false,
        sandboxId: "default.sandbox-1",
        cleanup: { status: "retained" }
      }
    });

    expect(result.verificationResult?.changedFiles).toEqual([
      { path: "src/lib/validation.ts", content: "export const schema = z.string().min(1);\n" }
    ]);
  });

  it("fails repair enrichment instead of returning partial verified files", async () => {
    vi.stubEnv("TRUEFORGE_REPAIR_MIN_INTERVAL_MS", "0");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-context")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-context.sh",
            exit_code: 0,
            context: "--- src/lib/missing.ts\nexport const value = 1;"
          }
        });
      }

      if (href.endsWith("/api/v1/models")) {
        return Response.json({ data: [{ name: "google-gemini/gemini-3-6-flash" }] });
      }

      if (href.endsWith("/api/v1/sessions") && method === "POST") {
        return Response.json({ data: { id: "session-1" } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns") && method === "POST") {
        return Response.json({ data: { id: "turn-1", state: { status: "running" } } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns/turn-1")) {
        return Response.json({
          data: {
            id: "turn-1",
            state: {
              status: "done",
              output: {
                content: JSON.stringify({
                  summary: "Update missing source.",
                  textReplacements: [
                    { path: "src/lib/missing.ts", old_text: "value = 1", new_text: "value = 2" }
                  ]
                })
              },
              required_actions: []
            }
          }
        });
      }

      if (
        href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-verifications")
      ) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-verify.sh",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_UPGRADE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                upgradeStatus: "VERIFIED",
                upgrade: { modelRepairRequired: false, runtimeChangeRequired: false },
                commands: [
                  { command: "npm run typecheck", exitCode: 0, durationMs: 3, output: "ok" }
                ]
              }),
              "UPGRADEPILOT_UPGRADE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "retained" }
          }
        });
      }

      if (href === "https://api.github.com/repos/acme/demo") {
        return Response.json({
          name: "demo",
          owner: { login: "acme" },
          private: false,
          html_url: "https://github.com/acme/demo",
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-30T00:00:00Z"
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.runNpmUpgradeRepairHandoff({
        repositoryUrl: "https://github.com/acme/demo",
        packageName: "zod",
        currentVersion: "3.25.0",
        targetVersion: "4.4.3",
        verificationResult: {
          status: "FAILED",
          commands: [
            { command: "npm run typecheck", exitCode: 1, durationMs: 20, output: "failed" }
          ],
          skippedScripts: [],
          modelRepairRequired: true,
          runtimeChangeRequired: false,
          sandboxId: "default.sandbox-1",
          cleanup: { status: "retained" }
        }
      })
    ).resolves.toMatchObject({
      status: "failed",
      summary: expect.stringContaining(
        "Verified repair file enrichment failed for acme/demo:src/lib/missing.ts"
      ),
      verificationResult: null
    });
  });

  it("includes recent TrueForge events when a repair handoff reaches the iteration limit", async () => {
    vi.stubEnv("TRUEFORGE_REPAIR_MIN_INTERVAL_MS", "0");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-1/repair-context")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-repair-context.sh",
            exit_code: 0,
            context: "--- src/lib/validation.ts\nzod failure context"
          }
        });
      }

      if (href.endsWith("/api/v1/models")) {
        return Response.json({ data: [{ name: "google-gemini/gemini-3-6-flash" }] });
      }

      if (href.endsWith("/api/v1/sessions") && method === "POST") {
        return Response.json({ data: { id: "session-1" } });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns") && method === "POST") {
        return Response.json({
          data: {
            id: "turn-1",
            state: { status: "running" }
          }
        });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns/turn-1")) {
        return Response.json({
          data: {
            id: "turn-1",
            state: {
              status: "error",
              message: "You have reached iteration limit of 5, please request again"
            }
          }
        });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns/turn-1/events?limit=100")) {
        return Response.json({
          data: [
            {
              type: "turn.created",
              id: "event-1",
              turn_id: "turn-1",
              state: { status: "running" }
            },
            {
              type: "model.message",
              id: "event-2",
              content: "I will inspect the provided failure evidence.",
              finish_reason: "tool_calls",
              usage: { input_tokens: 100, output_tokens: 20 }
            },
            {
              type: "turn.done",
              id: "event-3",
              state: {
                status: "error",
                message: "You have reached iteration limit of 5, please request again"
              }
            }
          ],
          pagination: { next_page_token: null }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const result = await client.runNpmUpgradeRepairHandoff({
      repositoryUrl: "https://github.com/acme/demo",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      verificationResult: {
        status: "FAILED",
        commands: [{ command: "npm run test", exitCode: 1, durationMs: 20, output: "failed" }],
        skippedScripts: [],
        modelRepairRequired: true,
        runtimeChangeRequired: false,
        sandboxId: "default.sandbox-1",
        cleanup: { status: "retained" }
      }
    });

    expect(result.status).toBe("failed");
    expect(result.sessionId).toBe("session-1");
    expect(result.turnId).toBe("turn-1");
    expect(result.summary).toContain("Recent TrueForge turn events");
    expect(result.summary).toContain("[model.message] I will inspect");
    expect(result.summary).toContain("tokens=100/20");
  });
});

describe("TrueForgeSandboxProvider", () => {
  it("blocks deterministic baseline execution when the contract lacks direct sandbox exec", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/openapi.json")) {
        return Response.json({
          paths: {
            "/api/v1/sessions": {},
            "/api/v1/sessions/{session_id}/turns": {}
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });
    const provider = new TrueForgeSandboxProvider(client);

    await expect(
      provider.createWorkspace({ repositoryUrl: "https://github.com/acme/demo" })
    ).rejects.toThrow(TrueForgeIntegrationError);
  });

  it("runs baseline verification through the deterministic TrueForge sandbox API", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: href, body });

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-baseline-runs")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "node /opt/tf/tool-results/upgradepilot-baseline.js",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_BASELINE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                commands: [
                  {
                    command: "git clone --depth 1 https://github.com/acme/demo repo",
                    exitCode: 0,
                    durationMs: 4,
                    output: ""
                  },
                  { command: "npm ci", exitCode: 0, durationMs: 10, output: "installed" },
                  { command: "npm run test", exitCode: 0, durationMs: 12, output: "ok" }
                ],
                package: { skippedScripts: ["format:check", "lint", "typecheck", "build"] }
              }),
              "UPGRADEPILOT_BASELINE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "deleted" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });
    const provider = new TrueForgeSandboxProvider(client);

    const result = await provider.runBaseline({
      repositoryUrl: "https://github.com/acme/demo",
      scripts: { test: "vitest run" },
      packageManager: "npm"
    });

    expect(result.status).toBe("PASSED");
    expect(result.install.command).toBe("npm ci");
    expect(result.verification.map((command) => command.command)).toEqual(["npm run test"]);
    expect(requests.map((request) => request.url)).not.toContain(
      "http://trueforge.test/api/v1/models"
    );
    expect(requests.some((request) => request.url.includes("/api/v1/sessions"))).toBe(false);
    expect(
      requests.find((request) => request.url.endsWith("/api/v1/sandboxes/npm-baseline-runs"))?.body
    ).toMatchObject({
      repository_url: "https://github.com/acme/demo",
      package_manager: "npm",
      timeout_seconds: 600
    });
  });

  it("treats failed deterministic sandbox cleanup as an infrastructure error", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-baseline-runs")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "node /opt/tf/tool-results/upgradepilot-baseline.js",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_BASELINE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                commands: [{ command: "npm ci", exitCode: 0, durationMs: 10, output: "installed" }]
              }),
              "UPGRADEPILOT_BASELINE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "failed", error: "delete failed" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.runNpmBaselineSandbox({
        repositoryUrl: "https://github.com/acme/demo",
        scripts: {},
        packageManager: "npm"
      })
    ).rejects.toThrow("TrueForge baseline sandbox cleanup failed: delete failed.");
  });

  it("reports deterministic sandbox bootstrap output when result markers are missing", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-baseline-runs")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "node /opt/tf/tool-results/upgradepilot-baseline.js",
            exit_code: 1,
            output: "node: command not found",
            cleanup: { status: "deleted" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.runNpmBaselineSandbox({
        repositoryUrl: "https://github.com/acme/demo",
        scripts: {},
        packageManager: "npm"
      })
    ).rejects.toThrow(
      "TrueForge baseline workflow output did not contain the UpgradePilot result markers. Command: node /opt/tf/tool-results/upgradepilot-baseline.js. Exit code: 1. Output: node: command not found"
    );
  });

  it("maps an install failure from the workflow without running verification commands", async () => {
    const result = parseBaselineWorkflowResult(
      [
        "UPGRADEPILOT_BASELINE_RESULT_START",
        JSON.stringify({
          overallStatus: "FAILED",
          commands: [
            {
              command: "git clone --depth 1 https://github.com/acme/demo repo",
              exitCode: 0,
              durationMs: 4,
              output: ""
            },
            { command: "npm ci", exitCode: 1, durationMs: 10, output: "install failed" }
          ]
        }),
        "UPGRADEPILOT_BASELINE_RESULT_END"
      ].join("\n")
    );

    expect(result.overallStatus).toBe("FAILED");
    expect(result.commands.find((command) => command.command === "npm ci")?.exitCode).toBe(1);
  });

  it("runs deterministic npm upgrade verification through the sandbox endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          repository_url: "https://github.com/acme/demo",
          package_manager: "npm",
          package_name: "react",
          target_version: "19.0.0",
          retain_failed_sandbox: true
        });

        return Response.json({
          data: {
            sandbox_id: "default.sandbox-1",
            command: "bash /opt/tf/tool-results/upgradepilot-upgrade.sh",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_UPGRADE_RESULT_START",
              JSON.stringify({
                overallStatus: "PASSED",
                upgradeStatus: "VERIFIED",
                upgrade: {
                  modelRepairRequired: false,
                  runtimeChangeRequired: false
                },
                package: {
                  skippedScripts: ["lint"]
                },
                commands: [
                  {
                    command: "git clone --depth 1 https://github.com/acme/demo repo",
                    exitCode: 0,
                    durationMs: 10,
                    output: ""
                  },
                  {
                    command: "npm install react@19.0.0",
                    exitCode: 0,
                    durationMs: 20,
                    output: "changed 1 package"
                  },
                  { command: "npm ci", exitCode: 0, durationMs: 30, output: "installed" },
                  { command: "npm run test", exitCode: 0, durationMs: 40, output: "passed" }
                ]
              }),
              "UPGRADEPILOT_UPGRADE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "deleted" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const result = await client.runNpmUpgradeSandbox({
      repositoryUrl: "https://github.com/acme/demo",
      packageManager: "npm",
      packageName: "react",
      targetVersion: "19.0.0"
    });

    expect(result.status).toBe("VERIFIED");
    expect(result.modelRepairRequired).toBe(false);
    expect(result.runtimeChangeRequired).toBe(false);
    expect(result.sandboxId).toBe("default.sandbox-1");
    expect(result.cleanup).toEqual({ status: "deleted" });
    expect(result.commands.map((command) => command.command)).toContain("npm install react@19.0.0");
  });

  it("maps retained repairable upgrade sandboxes and can clean them up", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: href, body });

      if (href.endsWith("/healthz")) {
        return Response.json({ status: "ok", version: "0.2.0-rc.0" });
      }

      if (href.endsWith("/api/v1/settings/sandbox-providers")) {
        return Response.json({
          data: {
            manifest: { type: "daytona" },
            status: "ready",
            status_reason: null
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-2",
            command: "bash /opt/tf/tool-results/upgradepilot-upgrade.sh",
            exit_code: 0,
            output: [
              "UPGRADEPILOT_UPGRADE_RESULT_START",
              JSON.stringify({
                overallStatus: "FAILED",
                upgradeStatus: "FAILED",
                upgrade: {
                  modelRepairRequired: true,
                  runtimeChangeRequired: false
                },
                commands: [
                  { command: "npm install zod@4.0.0", exitCode: 0, durationMs: 20, output: "ok" },
                  { command: "npm ci", exitCode: 0, durationMs: 30, output: "installed" },
                  {
                    command: "npm run test",
                    exitCode: 1,
                    durationMs: 40,
                    output: "required_error is deprecated"
                  }
                ]
              }),
              "UPGRADEPILOT_UPGRADE_RESULT_END"
            ].join("\n"),
            cleanup: { status: "retained" }
          }
        });
      }

      if (href.endsWith("/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-2/cleanup")) {
        return Response.json({
          data: {
            sandbox_id: "default.sandbox-2",
            cleanup: { status: "deleted" }
          }
        });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new TrueForgeClient({
      baseUrl: "http://trueforge.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    const result = await client.runNpmUpgradeSandbox({
      repositoryUrl: "https://github.com/acme/demo",
      packageManager: "npm",
      packageName: "zod",
      targetVersion: "4.0.0"
    });

    expect(result.status).toBe("FAILED");
    expect(result.modelRepairRequired).toBe(true);
    expect(result.sandboxId).toBe("default.sandbox-2");
    expect(result.cleanup).toEqual({ status: "retained" });

    await expect(
      client.cleanupNpmUpgradeSandbox({ sandboxId: "default.sandbox-2" })
    ).resolves.toBeUndefined();
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "http://trueforge.test/api/v1/sandboxes/npm-upgrade-runs/default.sandbox-2/cleanup",
      body: {}
    });
  });

  it("parses upgrade workflow failures that require repair handoff", () => {
    const result = parseUpgradeWorkflowResult(
      [
        "UPGRADEPILOT_UPGRADE_RESULT_START",
        JSON.stringify({
          overallStatus: "FAILED",
          upgradeStatus: "FAILED",
          upgrade: {
            modelRepairRequired: true,
            runtimeChangeRequired: false
          },
          commands: [{ command: "npm run test", exitCode: 1, durationMs: 10, output: "failed" }]
        }),
        "UPGRADEPILOT_UPGRADE_RESULT_END"
      ].join("\n")
    );

    expect(result.upgradeStatus).toBe("FAILED");
    expect(result.upgrade?.modelRepairRequired).toBe(true);
  });

  it("accepts blocked deterministic workflow results", () => {
    const result = parseBaselineWorkflowResult(
      [
        "UPGRADEPILOT_BASELINE_RESULT_START",
        JSON.stringify({
          overallStatus: "BLOCKED",
          commands: [
            {
              command: "npm ci",
              exitCode: 1,
              durationMs: 10,
              output: "npm error code EBADENGINE"
            }
          ]
        }),
        "UPGRADEPILOT_BASELINE_RESULT_END"
      ].join("\n")
    );

    expect(result.overallStatus).toBe("BLOCKED");
  });

  it("rejects malformed baseline workflow output", () => {
    expect(() => parseBaselineWorkflowResult("not json")).toThrow(TrueForgeIntegrationError);
  });
});
