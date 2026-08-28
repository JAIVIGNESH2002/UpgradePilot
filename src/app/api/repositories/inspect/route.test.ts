import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/repositories/inspect/route";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";

vi.mock("@/lib/repository-inspection", () => ({
  inspectPublicNpmRepository: vi.fn()
}));

const inspectPublicNpmRepositoryMock = vi.mocked(inspectPublicNpmRepository);

describe("POST /api/repositories/inspect", () => {
  beforeEach(() => {
    inspectPublicNpmRepositoryMock.mockReset();
    process.env.GITHUB_TOKEN = "unit-test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ "dist-tags": { latest: "19.0.0" } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inspects a public npm repository with the server-side GitHub token", async () => {
    const inspection = makeRepositoryInspection();
    inspectPublicNpmRepositoryMock.mockResolvedValue(inspection);

    const response = await POST(
      new Request("http://localhost/api/repositories/inspect", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: " https://github.com/acme/widgets " })
      })
    );

    await expect(response.json()).resolves.toEqual({
      inspection,
      dependencyVersions: {
        react: {
          packageName: "react",
          latestVersion: "19.0.0",
          currentComparableVersion: "19.0.0",
          changeType: "current",
          lookupStatus: "found",
          reason: null
        }
      }
    });
    expect(response.status).toBe(200);
    expect(inspectPublicNpmRepositoryMock).toHaveBeenCalledWith("https://github.com/acme/widgets", {
      token: "unit-test-token"
    });
  });

  it("returns a validation error for a missing repository URL", async () => {
    const response = await POST(
      new Request("http://localhost/api/repositories/inspect", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "" })
      })
    );

    await expect(response.json()).resolves.toEqual({ message: "Repository URL is required." });
    expect(response.status).toBe(400);
    expect(inspectPublicNpmRepositoryMock).not.toHaveBeenCalled();
  });

  it("returns the inspection error message", async () => {
    inspectPublicNpmRepositoryMock.mockRejectedValue(new Error("Use a repository URL"));

    const response = await POST(
      new Request("http://localhost/api/repositories/inspect", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/acme/widgets/issues" })
      })
    );

    await expect(response.json()).resolves.toEqual({ message: "Use a repository URL" });
    expect(response.status).toBe(400);
  });
});

function makeRepositoryInspection() {
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
        name: "npm",
        declared: "npm@10.0.0",
        lockfile: { type: "npm", path: "package-lock.json", version: 3 },
        support: "supported",
        installCommand: "npm ci"
      },
      hasPackageLock: true,
      lockfileVersion: 3,
      dependencies: [
        {
          packageName: "react",
          currentVersion: "^19.0.0",
          resolvedVersion: "19.0.0",
          kind: "dependency"
        }
      ],
      scripts: { test: "vitest run" }
    }
  } satisfies Awaited<ReturnType<typeof inspectPublicNpmRepository>>;
}
