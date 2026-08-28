import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/repositories/baseline/route";
import { runBaselineVerification } from "@/lib/baseline";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";

vi.mock("@/lib/baseline", () => ({
  runBaselineVerification: vi.fn()
}));

vi.mock("@/lib/repository-inspection", () => ({
  inspectPublicNpmRepository: vi.fn()
}));

const runBaselineVerificationMock = vi.mocked(runBaselineVerification);
const inspectPublicNpmRepositoryMock = vi.mocked(inspectPublicNpmRepository);

describe("POST /api/repositories/baseline", () => {
  beforeEach(() => {
    runBaselineVerificationMock.mockReset();
    inspectPublicNpmRepositoryMock.mockReset();
  });

  it("returns a healthy baseline for passing supported npm projects", async () => {
    inspectPublicNpmRepositoryMock.mockResolvedValue(makeRepositoryInspection("npm"));
    runBaselineVerificationMock.mockResolvedValue({
      status: "PASSED",
      install: { command: "npm ci", exitCode: 0, durationMs: 10, output: "ok" },
      verification: [{ command: "npm run test", exitCode: 0, durationMs: 10, output: "ok" }],
      skippedScripts: ["format:check", "lint", "typecheck", "build"]
    });

    const response = await POST(makeRequest("https://github.com/acme/widgets"));
    const body = (await response.json()) as { baseline: { status: string; commands: number } };

    expect(response.status).toBe(200);
    expect(body.baseline.status).toBe("healthy");
    expect(body.baseline.commands).toBe(2);
    expect(runBaselineVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryUrl: "https://github.com/acme/widgets",
        packageManager: "npm"
      })
    );
  });

  it("returns failed for failing supported pnpm projects", async () => {
    inspectPublicNpmRepositoryMock.mockResolvedValue(makeRepositoryInspection("pnpm"));
    runBaselineVerificationMock.mockResolvedValue({
      status: "FAILED",
      install: {
        command: "pnpm install --frozen-lockfile",
        exitCode: 0,
        durationMs: 10,
        output: "ok"
      },
      verification: [{ command: "pnpm run test", exitCode: 1, durationMs: 10, output: "fail" }],
      skippedScripts: ["format:check", "lint", "typecheck", "build"]
    });

    const response = await POST(makeRequest("https://github.com/acme/widgets"));
    const body = (await response.json()) as { baseline: { status: string; commands: number } };

    expect(body.baseline.status).toBe("failed");
    expect(body.baseline.commands).toBe(2);
    expect(runBaselineVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ packageManager: "pnpm" })
    );
  });

  it("returns interrupted for detected unsupported package managers", async () => {
    inspectPublicNpmRepositoryMock.mockResolvedValue(makeRepositoryInspection("yarn"));

    const response = await POST(makeRequest("https://github.com/acme/widgets"));
    const body = (await response.json()) as { baseline: { status: string; message: string } };

    expect(body.baseline.status).toBe("interrupted");
    expect(body.baseline.message).toContain("yarn projects");
    expect(runBaselineVerificationMock).not.toHaveBeenCalled();
  });
});

function makeRequest(repositoryUrl: string) {
  return new Request("http://localhost/api/repositories/baseline", {
    method: "POST",
    body: JSON.stringify({ repositoryUrl })
  });
}

function makeRepositoryInspection(packageManagerName: "npm" | "pnpm" | "yarn") {
  return {
    metadata: {
      owner: "acme",
      name: "widgets",
      url: "https://github.com/acme/widgets",
      description: "Useful widgets",
      defaultBranch: "main",
      language: "TypeScript",
      updatedAt: "2026-08-27T10:00:00Z"
    },
    package: {
      packageName: "widgets",
      nodeRequirement: ">=22",
      packageManager: {
        name: packageManagerName,
        declared: `${packageManagerName}@1.0.0`,
        lockfile:
          packageManagerName === "npm"
            ? { type: "npm" as const, path: "package-lock.json", version: 3 }
            : packageManagerName === "pnpm"
              ? { type: "pnpm" as const, path: "pnpm-lock.yaml", version: null }
              : { type: "yarn" as const, path: "yarn.lock", version: null },
        support: packageManagerName === "yarn" ? ("unsupported" as const) : ("supported" as const),
        installCommand:
          packageManagerName === "npm"
            ? "npm ci"
            : packageManagerName === "pnpm"
              ? "pnpm install --frozen-lockfile"
              : null
      },
      hasPackageLock: packageManagerName === "npm",
      lockfileVersion: packageManagerName === "npm" ? 3 : null,
      dependencies: [],
      scripts: { test: "vitest run" }
    }
  } satisfies Awaited<ReturnType<typeof inspectPublicNpmRepository>>;
}
