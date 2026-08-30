import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryWorkspace } from "@/app/workspace";
import type { RepositoryInspection } from "@/lib/package-inspection";
import {
  REPOSITORY_WORKSPACE_STORAGE_KEY,
  serializeRepositoryWorkspaceSnapshot,
  type WorkspaceBaselineStep,
  workspaceRepositoryFromInspection
} from "@/lib/repository-workspace";

describe("RepositoryWorkspace", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders an empty workspace state", async () => {
    render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "Add a repository to begin" })).toBeVisible();
    expect(screen.getByLabelText("Public GitHub repository URL")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeEnabled();
  });

  it("adds and selects an inspected repository", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        inspection: makeRepositoryInspection("acme", "widgets"),
        dependencyVersions: makeDependencyVersions()
      })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "Add a repository to begin" });
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), {
      target: { value: "https://github.com/acme/widgets" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Baseline Not run widgets acme" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText("react")).toBeVisible();
    expect(screen.getByText("19.0.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify upgrade" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repositories/inspect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/acme/widgets" })
      })
    );
  });

  it("persists repositories and selected state across reloads", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets")
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );

    const { unmount } = render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    unmount();
    render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Baseline Not run widgets acme" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("removes the selected repository and selects the remaining repository", async () => {
    const widgets = workspaceRepositoryFromInspection(makeRepositoryInspection("acme", "widgets"));
    const tools = workspaceRepositoryFromInspection(makeRepositoryInspection("acme", "tools"));
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [widgets, tools],
        selectedRepositoryId: widgets.id
      })
    );
    render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    fireEvent.click(screen.getByLabelText("Remove acme/widgets"));

    expect(await screen.findByRole("heading", { name: "tools" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Baseline Not run widgets acme" })
    ).not.toBeInTheDocument();
  });

  it("shows a client validation error for an empty repository URL", async () => {
    render(<RepositoryWorkspace />);

    fireEvent.click(await screen.findByRole("button", { name: "Add repository" }));

    expect(await screen.findByText("Repository inspection failed")).toBeVisible();
    expect(screen.getByText("Enter a public GitHub repository URL.")).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows repository inspection failure messages", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ message: "Only github.com repository URLs are supported." }, { status: 400 })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "Add a repository to begin" });
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), {
      target: { value: "https://example.com/acme/widgets" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(await screen.findByText("Repository inspection failed")).toBeVisible();
    expect(screen.getByText("Only github.com repository URLs are supported.")).toBeVisible();
  });

  it("filters dependencies by search and devDependency type", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.change(screen.getByLabelText("Search dependencies"), {
      target: { value: "vite" }
    });

    expect(screen.getByText("vitest")).toBeVisible();
    expect(screen.queryByText("react")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search dependencies"), {
      target: { value: "" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));

    expect(screen.getByText("vitest")).toBeVisible();
    expect(screen.queryByText("react")).not.toBeInTheDocument();
  });

  it("shows loading and dependency empty states", async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "Add a repository to begin" });
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), {
      target: { value: "https://github.com/acme/empty" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(screen.getByRole("button", { name: "Adding..." })).toBeDisabled();
    resolveFetch(Response.json({ inspection: makeRepositoryInspection("acme", "empty", []) }));

    const dependencyTable = await screen.findByRole("table");
    expect(
      within(dependencyTable).getByText("No dependencies or devDependencies were found.")
    ).toBeVisible();
  });

  it("shows baseline CTA states and stores mocked healthy results", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        run: {
          id: "run-1",
          repositoryUrl: "https://github.com/acme/widgets",
          status: "completed",
          baseline: {
            status: "healthy",
            updatedAt: "2026-08-28T10:00:00Z",
            commands: 2,
            message: null,
            steps: makeBaselineSteps()
          }
        }
      })
    );
    render(<RepositoryWorkspace />);

    expect(await screen.findByText("Baseline: Not run")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run baseline" }));

    expect(await screen.findByText("Baseline: Healthy")).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-run baseline" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Baseline details: Healthy" }));
    expect(screen.getByText("Install dependencies")).toBeVisible();
    expect(screen.getByText("npm run test")).toBeVisible();
    expect(screen.getAllByText("Passed")).toHaveLength(2);
  });

  it("automatically establishes baseline when preparing Verify Upgrade", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          run: {
            id: "run-1",
            repositoryUrl: "https://github.com/acme/widgets",
            status: "completed",
            baseline: {
              status: "healthy",
              updatedAt: "2026-08-28T10:00:00Z",
              commands: 2,
              message: null,
              steps: makeBaselineSteps()
            }
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            run: makeUpgradeRun({ status: "completed" })
          },
          { status: 202 }
        )
      );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));

    expect(await screen.findByRole("heading", { name: "react" })).toBeVisible();
    expect(screen.getByText("Upgrade run")).toBeVisible();
    expect(
      screen.getAllByText(
        (_, element) => element?.textContent?.includes("18.3.1 to 19.0.0") ?? false
      ).length
    ).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/repositories/baseline/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/acme/widgets" })
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/repositories/upgrade-runs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"packageName":"react"')
      })
    );
  });

  it("starts Verify Upgrade directly when baseline is already healthy", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    repository.baseline = {
      status: "healthy",
      updatedAt: "2026-08-28T10:00:00Z",
      commands: 2,
      message: null,
      steps: makeBaselineSteps()
    };
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          run: makeUpgradeRun({ status: "completed" })
        },
        { status: 202 }
      )
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));

    expect(await screen.findByRole("heading", { name: "react" })).toBeVisible();
    expect(screen.getByText("Install target dependency")).toBeVisible();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/repositories/baseline/runs",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows upgrade run polling progress", async () => {
    vi.useFakeTimers();
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    repository.baseline = {
      status: "healthy",
      updatedAt: "2026-08-28T10:00:00Z",
      commands: 2,
      message: null,
      steps: makeBaselineSteps()
    };
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json(
          {
            run: makeUpgradeRun()
          },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          run: {
            ...makeUpgradeRun(),
            steps: [
              { ...makeUpgradeRun().steps[0], status: "passed" },
              { ...makeUpgradeRun().steps[1], status: "running" },
              ...makeUpgradeRun().steps.slice(2)
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          run: {
            ...makeUpgradeRun(),
            status: "completed",
            outcome: "repair_failed",
            message:
              "Upgrade changed CI behavior and the repair cycle did not produce a verified result.",
            updatedAt: "2026-08-28T10:01:00Z",
            steps: makeUpgradeRun().steps.map((step, index) => ({
              ...step,
              status: index === 5 ? "skipped" : "passed"
            }))
          }
        })
      );

    render(<RepositoryWorkspace />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("heading", { name: "widgets" })).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Create sandbox")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledWith("/api/repositories/upgrade-runs/status?runId=upgrade-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("Repair failed")).toBeVisible();

    vi.useRealTimers();
  });

  it("returns from an upgrade run to the repository detail", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    repository.baseline = {
      status: "healthy",
      updatedAt: "2026-08-28T10:00:00Z",
      commands: 2,
      message: null,
      steps: makeBaselineSteps()
    };
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ run: makeUpgradeRun({ status: "completed" }) }, { status: 200 })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));
    expect(await screen.findByText("Upgrade run")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to repository" }));

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Dependencies" })).toBeVisible();
    expect(screen.getByText("Verified upgrade")).toBeVisible();
  });

  it("keeps Verify Upgrade on the repository page when baseline fails", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        run: {
          id: "run-1",
          repositoryUrl: "https://github.com/acme/widgets",
          status: "completed",
          baseline: {
            status: "failed",
            updatedAt: "2026-08-28T10:00:00Z",
            commands: 1,
            message: "npm ci failed",
            steps: [{ ...makeBaselineSteps()[0], status: "failed", output: "npm ci failed" }]
          }
        }
      })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));

    expect(await screen.findByText("Baseline: Failed")).toBeVisible();
    expect(
      screen.getByText("A healthy baseline is required before opening an upgrade run.")
    ).toBeVisible();
    expect(screen.queryByText("Upgrade run")).not.toBeInTheDocument();
  });

  it("polls baseline runs and updates one active step at a time", async () => {
    vi.useFakeTimers();
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json(
          {
            run: {
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
                  },
                  {
                    name: "Test",
                    command: "npm run test",
                    status: "pending",
                    durationMs: null,
                    output: null
                  }
                ]
              }
            }
          },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          run: {
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
                  status: "pending",
                  durationMs: null,
                  output: null
                },
                {
                  name: "Test",
                  command: "npm run test",
                  status: "running",
                  durationMs: null,
                  output: null
                }
              ]
            }
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          run: {
            id: "run-1",
            repositoryUrl: "https://github.com/acme/widgets",
            status: "completed",
            baseline: {
              status: "healthy",
              updatedAt: "2026-08-28T10:00:00Z",
              commands: 2,
              message: null,
              steps: makeBaselineSteps()
            }
          }
        })
      );

    render(<RepositoryWorkspace />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("heading", { name: "widgets" })).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run baseline" }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Baseline: Running")).toBeVisible();
    expect(screen.getByText("Install dependencies")).toBeVisible();
    expect(screen.getByText("npm ci")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("npm run test")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("Baseline: Healthy")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/repositories/baseline/runs/status?runId=run-1");

    vi.useRealTimers();
  });

  it("persists expanded baseline command evidence across reloads", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      makeDependencyVersions()
    );
    repository.baseline = {
      status: "healthy",
      updatedAt: "2026-08-28T10:00:00Z",
      commands: 2,
      message: null,
      steps: makeBaselineSteps()
    };
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );

    render(<RepositoryWorkspace />);

    expect(await screen.findByText("Baseline: Healthy")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Baseline details: Healthy" }));

    expect(screen.getByText("Install dependencies")).toBeVisible();
    expect(screen.getByText("npm ci")).toBeVisible();
    expect(screen.getByText("npm run test")).toBeVisible();
  });

  it("refreshes stale persisted repository inspection and latest-version data", async () => {
    const staleRepository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("keystonejs", "keystone")
    );
    const refreshedInspection = makeRepositoryInspection("keystonejs", "keystone");
    staleRepository.package.packageManager = {
      name: "pnpm",
      declared: "pnpm@10.0.0",
      lockfile: null,
      support: "supported",
      installCommand: "pnpm install --frozen-lockfile"
    };
    staleRepository.dependencyVersions = {};
    refreshedInspection.package.packageManager = {
      name: "pnpm",
      declared: "pnpm@10.0.0",
      lockfile: { type: "pnpm", path: "pnpm-lock.yaml", version: null },
      support: "supported",
      installCommand: "pnpm install --frozen-lockfile"
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        inspection: refreshedInspection,
        dependencyVersions: makeDependencyVersions()
      })
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [staleRepository],
        selectedRepositoryId: staleRepository.id
      })
    );

    render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "keystone" })).toBeVisible();

    await waitFor(() => expect(screen.getByText("pnpm-lock.yaml")).toBeVisible());
    expect(screen.getByText("19.0.0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify upgrade" })).toBeEnabled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/repositories/inspect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/keystonejs/keystone" })
      })
    );
  });

  it("allows manually refreshing unavailable latest-version data", async () => {
    const repository = workspaceRepositoryFromInspection(
      makeRepositoryInspection("acme", "widgets"),
      {
        react: {
          packageName: "react",
          latestVersion: null,
          currentComparableVersion: "18.3.1",
          changeType: "unavailable",
          lookupStatus: "unavailable",
          reason: "npm registry returned 503."
        },
        vitest: {
          packageName: "vitest",
          latestVersion: null,
          currentComparableVersion: "4.0.0",
          changeType: "unavailable",
          lookupStatus: "unavailable",
          reason: "npm registry returned 503."
        }
      }
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        inspection: makeRepositoryInspection("acme", "widgets"),
        dependencyVersions: makeDependencyVersions()
      })
    );
    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({
        repositories: [repository],
        selectedRepositoryId: repository.id
      })
    );

    render(<RepositoryWorkspace />);

    expect(await screen.findByRole("heading", { name: "widgets" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh versions" }));

    await waitFor(() => expect(screen.getByText("19.0.0")).toBeVisible());
    expect(screen.getByRole("button", { name: "Verify upgrade" })).toBeEnabled();
  });
});

function makeRepositoryInspection(
  owner: string,
  name: string,
  dependencies: RepositoryInspection["package"]["dependencies"] = [
    {
      packageName: "react",
      currentVersion: "^18.0.0",
      resolvedVersion: "18.3.1",
      kind: "dependency"
    },
    {
      packageName: "vitest",
      currentVersion: "^4.0.0",
      resolvedVersion: "4.0.0",
      kind: "devDependency"
    }
  ]
): RepositoryInspection {
  return {
    metadata: {
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      description: `${name} repository`,
      defaultBranch: "main",
      language: "TypeScript",
      updatedAt: "2026-08-27T10:00:00Z"
    },
    package: {
      packageName: name,
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
      dependencies,
      scripts: { test: "vitest run" }
    }
  };
}

function makeDependencyVersions() {
  return {
    react: {
      packageName: "react",
      latestVersion: "19.0.0",
      currentComparableVersion: "18.3.1",
      changeType: "major",
      lookupStatus: "found",
      reason: null
    },
    vitest: {
      packageName: "vitest",
      latestVersion: "4.0.0",
      currentComparableVersion: "4.0.0",
      changeType: "current",
      lookupStatus: "found",
      reason: null
    }
  } as const;
}

function makeBaselineSteps(): WorkspaceBaselineStep[] {
  return [
    {
      name: "Install dependencies",
      command: "npm ci",
      status: "passed",
      durationMs: 1200,
      output: "installed"
    },
    {
      name: "Test",
      command: "npm run test",
      status: "passed",
      durationMs: 900,
      output: "2 passed"
    }
  ];
}

function makeUpgradeRun({ status = "running" }: { status?: "running" | "completed" } = {}) {
  return {
    id: "upgrade-1",
    repositoryUrl: "https://github.com/acme/widgets",
    packageName: "react",
    currentVersion: "18.3.1",
    targetVersion: "19.0.0",
    status,
    outcome: status === "completed" ? "verified" : null,
    message: "Preparing deterministic upgrade verification.",
    startedAt: "2026-08-28T10:00:00Z",
    updatedAt: status === "completed" ? "2026-08-28T10:01:00Z" : null,
    changedFiles:
      status === "completed"
        ? [{ path: "package.json", content: '{"dependencies":{"react":"19.0.0"}}\n' }]
        : [],
    pullRequest: null,
    steps: [
      {
        name: "Check baseline",
        command: null,
        status: "running",
        durationMs: null,
        output: null
      },
      {
        name: "Create sandbox",
        command: "TrueForge deterministic sandbox",
        status: "pending",
        durationMs: null,
        output: null
      },
      {
        name: "Clone repository",
        command: "git clone <public repository>",
        status: "pending",
        durationMs: null,
        output: null
      },
      {
        name: "Install target dependency",
        command: "npm install react@19.0.0 --package-lock-only",
        status: "pending",
        durationMs: null,
        output: null
      },
      {
        name: "Run verification",
        command: "npm ci && npm run available checks",
        status: "pending",
        durationMs: null,
        output: null
      },
      {
        name: "Repair and re-verify",
        command: "TrueForge repair agent + deterministic verification",
        status: "pending",
        durationMs: null,
        output: null
      }
    ]
  } as const;
}
