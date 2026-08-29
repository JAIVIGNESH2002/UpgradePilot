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
