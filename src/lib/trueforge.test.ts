import { describe, expect, it, vi } from "vitest";

import {
  TrueForgeClient,
  TrueForgeIntegrationError,
  TrueForgeSandboxProvider
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
});
