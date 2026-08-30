import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/repositories/upgrade-runs/pull-request/route";
import { clearUpgradeRunsForTests, getUpgradeRun, startUpgradeRun } from "@/lib/upgrade-run-store";

const createPullRequestMock = vi.fn();

vi.mock("@/lib/github", () => ({
  GitHubClient: vi.fn(function GitHubClientMock() {
    return {
      createPullRequest: createPullRequestMock
    };
  })
}));

describe("POST /api/repositories/upgrade-runs/pull-request", () => {
  afterEach(() => {
    clearUpgradeRunsForTests();
    createPullRequestMock.mockReset();
  });

  it("rejects unverified upgrade runs", async () => {
    const run = startUpgradeRun({
      repositoryUrl: "https://github.com/acme/widgets",
      packageName: "react",
      currentVersion: "18.3.1",
      targetVersion: "19.0.0",
      changeType: "major",
      packageManager: "npm",
      baseline: { ...healthyBaseline(), status: "failed", message: "npm test failed" }
    });

    const response = await POST(makeRequest(run.id));
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(409);
    expect(body.message).toBe("A pull request can only be created after a verified upgrade run.");
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it("creates a pull request from verified changed files", async () => {
    createPullRequestMock.mockResolvedValue({
      url: "https://github.com/acme/widgets/pull/7",
      number: 7,
      branchName: "upgradepilot/react-19.0.0-123"
    });
    const run = startUpgradeRun(
      {
        repositoryUrl: "https://github.com/acme/widgets",
        packageName: "react",
        currentVersion: "18.3.1",
        targetVersion: "19.0.0",
        changeType: "major",
        packageManager: "npm",
        baseline: healthyBaseline()
      },
      {
        runVerification: vi.fn(async () => ({
          status: "VERIFIED" as const,
          commands: [{ command: "npm run test", exitCode: 0, durationMs: 1, output: "ok" }],
          skippedScripts: [],
          modelRepairRequired: false,
          runtimeChangeRequired: false,
          sandboxId: "default.sandbox-1",
          cleanup: { status: "deleted" as const },
          changedFiles: [{ path: "package.json", content: "{\"dependencies\":{\"react\":\"19.0.0\"}}\n" }]
        }))
      }
    );

    await vi.waitFor(() => expect(getUpgradeRun(run.id)?.status).toBe("completed"));
    const response = await POST(makeRequest(run.id));

    expect(response.status).toBe(201);

    expect(createPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryUrl: "https://github.com/acme/widgets",
        title: "chore: upgrade react to 19.0.0",
        files: [{ path: "package.json", content: "{\"dependencies\":{\"react\":\"19.0.0\"}}\n" }]
      })
    );
  });
});

function makeRequest(runId: string) {
  return new Request("http://localhost/api/repositories/upgrade-runs/pull-request", {
    method: "POST",
    body: JSON.stringify({ runId })
  });
}

function healthyBaseline() {
  return {
    status: "healthy" as const,
    updatedAt: "2026-08-28T10:00:00Z",
    commands: 1,
    message: null,
    steps: []
  };
}
