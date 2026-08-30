import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/repositories/baseline/runs/status/route";
import { getBaselineRun } from "@/lib/baseline-run-store";

vi.mock("@/lib/baseline-run-store", () => ({
  getBaselineRun: vi.fn()
}));

const getBaselineRunMock = vi.mocked(getBaselineRun);

describe("GET /api/repositories/baseline/runs/status", () => {
  beforeEach(() => {
    getBaselineRunMock.mockReset();
  });

  it("returns the latest baseline run snapshot", async () => {
    getBaselineRunMock.mockReturnValue({
      id: "run-1",
      repositoryUrl: "https://github.com/acme/widgets",
      status: "completed",
      baseline: {
        status: "healthy",
        updatedAt: "2026-08-28T10:00:00Z",
        commands: 2,
        message: null,
        steps: [
          {
            name: "Test",
            command: "npm run test",
            status: "passed",
            durationMs: 1000,
            output: "ok"
          }
        ]
      }
    });

    const response = await GET(
      new Request("http://localhost/api/repositories/baseline/runs/status?runId=run-1")
    );

    await expect(response.json()).resolves.toMatchObject({
      run: {
        id: "run-1",
        status: "completed",
        baseline: { status: "healthy" }
      }
    });
    expect(response.status).toBe(200);
    expect(getBaselineRunMock).toHaveBeenCalledWith("run-1");
  });

  it("requires a run ID", async () => {
    const response = await GET(
      new Request("http://localhost/api/repositories/baseline/runs/status")
    );

    await expect(response.json()).resolves.toEqual({ message: "Baseline run ID is required." });
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown run IDs", async () => {
    getBaselineRunMock.mockReturnValue(null);

    const response = await GET(
      new Request("http://localhost/api/repositories/baseline/runs/status?runId=missing")
    );

    await expect(response.json()).resolves.toEqual({ message: "Baseline run was not found." });
    expect(response.status).toBe(404);
  });
});
