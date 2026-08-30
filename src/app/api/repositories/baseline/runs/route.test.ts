import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/repositories/baseline/runs/route";
import { startBaselineRun } from "@/lib/baseline-run-store";

vi.mock("@/lib/baseline-run-store", () => ({
  startBaselineRun: vi.fn()
}));

const startBaselineRunMock = vi.mocked(startBaselineRun);

describe("POST /api/repositories/baseline/runs", () => {
  beforeEach(() => {
    startBaselineRunMock.mockReset();
  });

  it("starts a baseline run and returns the pollable run snapshot", async () => {
    startBaselineRunMock.mockResolvedValue({
      id: "run-1",
      repositoryUrl: "https://github.com/acme/widgets",
      status: "running",
      baseline: {
        status: "unknown",
        updatedAt: null,
        commands: 0,
        message: "Baseline verification is running.",
        steps: [
          {
            name: "Install dependencies",
            command: "npm ci",
            status: "running",
            durationMs: null,
            output: null
          }
        ]
      }
    });

    const response = await POST(makeRequest("https://github.com/acme/widgets"));

    await expect(response.json()).resolves.toMatchObject({
      run: {
        id: "run-1",
        status: "running",
        baseline: {
          steps: [expect.objectContaining({ name: "Install dependencies", status: "running" })]
        }
      }
    });
    expect(response.status).toBe(202);
    expect(startBaselineRunMock).toHaveBeenCalledWith("https://github.com/acme/widgets");
  });

  it("returns a validation error for missing repository URLs", async () => {
    const response = await POST(makeRequest(""));

    await expect(response.json()).resolves.toEqual({ message: "Repository URL is required." });
    expect(response.status).toBe(400);
    expect(startBaselineRunMock).not.toHaveBeenCalled();
  });
});

function makeRequest(repositoryUrl: string) {
  return new Request("http://localhost/api/repositories/baseline/runs", {
    method: "POST",
    body: JSON.stringify({ repositoryUrl })
  });
}
