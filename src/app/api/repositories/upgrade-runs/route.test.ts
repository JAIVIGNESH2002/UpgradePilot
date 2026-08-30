import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/repositories/upgrade-runs/route";
import { clearUpgradeRunsForTests } from "@/lib/upgrade-run-store";

describe("POST /api/repositories/upgrade-runs", () => {
  afterEach(() => {
    clearUpgradeRunsForTests();
  });

  it("blocks an upgrade run when the submitted baseline is unhealthy", async () => {
    const response = await POST(
      new Request("http://localhost/api/repositories/upgrade-runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: "https://github.com/acme/widgets",
          packageName: "react",
          currentVersion: "18.3.1",
          targetVersion: "18.3.2",
          changeType: "patch",
          packageManager: "npm",
          baseline: { ...healthyBaseline(), status: "failed", message: "npm test failed" }
        })
      })
    );

    const body = (await response.json()) as {
      run: { status: string; packageName: string; outcome: string };
    };

    expect(response.status).toBe(200);
    expect(body.run.status).toBe("completed");
    expect(body.run.outcome).toBe("blocked");
    expect(body.run.packageName).toBe("react");
  });

  it("rejects unsupported package managers", async () => {
    const response = await POST(
      new Request("http://localhost/api/repositories/upgrade-runs", {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: "https://github.com/acme/widgets",
          packageName: "react",
          currentVersion: "18.3.1",
          targetVersion: "18.3.2",
          changeType: "patch",
          packageManager: "yarn",
          baseline: healthyBaseline()
        })
      })
    );

    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(400);
    expect(body.message).toBe("Only npm and pnpm upgrade verification is supported.");
  });
});

function healthyBaseline() {
  return {
    status: "healthy",
    updatedAt: "2026-08-28T10:00:00Z",
    commands: 1,
    message: null,
    steps: []
  };
}
