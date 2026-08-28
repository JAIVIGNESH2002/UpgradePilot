import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryWorkspace } from "@/app/workspace";
import type { RepositoryInspection } from "@/lib/package-inspection";
import {
  REPOSITORY_WORKSPACE_STORAGE_KEY,
  serializeRepositoryWorkspaceSnapshot,
  workspaceRepositoryFromInspection
} from "@/lib/repository-workspace";

describe("RepositoryWorkspace", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
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
        baseline: {
          status: "healthy",
          updatedAt: "2026-08-28T10:00:00Z",
          commands: 2,
          message: null
        }
      })
    );
    render(<RepositoryWorkspace />);

    expect(await screen.findByText("Baseline: Not run")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run baseline" }));

    expect(await screen.findByText("Baseline: Healthy")).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-run baseline" })).toBeEnabled();
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
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        baseline: {
          status: "healthy",
          updatedAt: "2026-08-28T10:00:00Z",
          commands: 2,
          message: null
        }
      })
    );
    render(<RepositoryWorkspace />);

    await screen.findByRole("heading", { name: "widgets" });
    fireEvent.click(screen.getByRole("button", { name: "Verify upgrade" }));

    expect(await screen.findByText("Baseline: Healthy")).toBeVisible();
    expect(screen.getByText("react can open an upgrade run targeting 19.0.0.")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/repositories/baseline",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/acme/widgets" })
      })
    );
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
