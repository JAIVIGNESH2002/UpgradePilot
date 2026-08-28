import { describe, expect, it, vi } from "vitest";

import {
  TrueForgeClient,
  TrueForgeIntegrationError,
  TrueForgeSandboxProvider,
  parseBaselineWorkflowResult
} from "@/lib/trueforge";

describe("TrueForgeClient", () => {
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

  it("runs baseline verification through a TrueForge sandbox-enabled session turn", async () => {
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

      if (href.endsWith("/api/v1/models")) {
        return Response.json({ data: [{ name: "provider/model" }] });
      }

      if (href.endsWith("/api/v1/sessions")) {
        return Response.json({ data: { id: "session-1" } }, { status: 201 });
      }

      if (href.endsWith("/api/v1/sessions/session-1/turns")) {
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
              required_actions: [],
              output: {
                content: JSON.stringify({
                  resultText: [
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
                  ].join("\n")
                })
              }
            }
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
    expect(
      requests.find((request) => request.url.endsWith("/api/v1/sessions"))?.body
    ).toMatchObject({
      agent: {
        spec: {
          config: {
            iteration_limit: 24,
            sandbox: { enabled: true, file_downloads: false }
          }
        }
      }
    });
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

  it("rejects malformed baseline workflow output", () => {
    expect(() => parseBaselineWorkflowResult("not json")).toThrow(TrueForgeIntegrationError);
  });
});
