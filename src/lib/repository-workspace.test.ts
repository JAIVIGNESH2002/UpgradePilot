import { describe, expect, it } from "vitest";

import type { RepositoryInspection } from "@/lib/package-inspection";
import type { WorkspaceRepository } from "@/lib/repository-workspace";
import {
  addOrUpdateRepository,
  filterDependencies,
  nextSelectedRepositoryId,
  parseRepositoryWorkspaceSnapshot,
  removeRepository,
  repositoryNeedsInspectionRefresh,
  serializeRepositoryWorkspaceSnapshot,
  toWorkspaceDependencies,
  workspaceRepositoryFromInspection
} from "@/lib/repository-workspace";

describe("repository workspace helpers", () => {
  it("creates stable repository ids and workspace records", () => {
    const repository = workspaceRepositoryFromInspection(makeRepository("Acme", "Widgets"));

    expect(repository.id).toBe("acme/widgets");
    expect(repository.repositoryUrl).toBe("https://github.com/Acme/Widgets");
    expect(repository.baseline.status).toBe("unknown");
    expect(repository.dependencyVersions).toEqual({});
  });

  it("adds, updates, removes, and selects repositories", () => {
    const widgets = makeWorkspaceRepository("acme", "widgets");
    const tools = makeWorkspaceRepository("acme", "tools");
    const updatedWidgets = {
      ...widgets,
      metadata: { ...widgets.metadata, description: "Updated" }
    };
    const repositories = addOrUpdateRepository([widgets, tools], updatedWidgets);

    expect(repositories).toHaveLength(2);
    expect(
      repositories.find((repository) => repository.id === widgets.id)?.metadata.description
    ).toBe("Updated");

    const remainingRepositories = removeRepository(repositories, widgets.id);

    expect(remainingRepositories).toEqual([tools]);
    expect(
      nextSelectedRepositoryId({
        repositories: remainingRepositories,
        currentSelectedRepositoryId: widgets.id,
        removedRepositoryId: widgets.id
      })
    ).toBe(tools.id);
    expect(
      nextSelectedRepositoryId({
        repositories: remainingRepositories,
        currentSelectedRepositoryId: tools.id
      })
    ).toBe(tools.id);
  });

  it("serializes and parses persisted repository workspace state", () => {
    const widgets = makeWorkspaceRepository("acme", "widgets");
    const serialized = serializeRepositoryWorkspaceSnapshot({
      repositories: [widgets],
      selectedRepositoryId: widgets.id
    });

    expect(parseRepositoryWorkspaceSnapshot(serialized)).toEqual({
      repositories: [widgets],
      selectedRepositoryId: widgets.id
    });
    expect(parseRepositoryWorkspaceSnapshot("{")).toEqual({
      repositories: [],
      selectedRepositoryId: null
    });
  });

  it("migrates older persisted repositories with string package managers", () => {
    const legacyRepository = {
      ...makeRepository("acme", "legacy"),
      id: "acme/legacy",
      repositoryUrl: "https://github.com/acme/legacy",
      baselineStatus: "passed",
      package: {
        ...makeRepository("acme", "legacy").package,
        packageManager: "npm@10.0.0",
        dependencies: [{ packageName: "react", currentVersion: "^18.0.0", kind: "dependency" }]
      }
    };

    const snapshot = parseRepositoryWorkspaceSnapshot(
      JSON.stringify({
        repositories: [legacyRepository],
        selectedRepositoryId: "acme/legacy"
      })
    );

    expect(snapshot.repositories[0]?.baseline.status).toBe("healthy");
    expect(snapshot.repositories[0]?.package.packageManager).toMatchObject({
      name: "npm",
      declared: "npm@10.0.0",
      lockfile: { path: "package-lock.json" },
      support: "supported"
    });
    expect(snapshot.repositories[0]?.package.dependencies[0]).toMatchObject({
      packageName: "react",
      resolvedVersion: null
    });
  });

  it("normalizes stale persisted package-manager support from detected lockfiles", () => {
    const staleRepository = {
      ...makeRepository("acme", "stale"),
      id: "acme/stale",
      repositoryUrl: "https://github.com/acme/stale",
      package: {
        ...makeRepository("acme", "stale").package,
        packageManager: {
          name: "unknown",
          declared: null,
          lockfile: { type: "npm", path: "package-lock.json", version: 3 },
          support: "unsupported",
          installCommand: null
        }
      }
    };

    const snapshot = parseRepositoryWorkspaceSnapshot(
      JSON.stringify({
        repositories: [staleRepository],
        selectedRepositoryId: "acme/stale"
      })
    );

    expect(snapshot.repositories[0]?.package.packageManager).toMatchObject({
      name: "npm",
      lockfile: { type: "npm", path: "package-lock.json" },
      support: "supported",
      installCommand: "npm ci"
    });
  });

  it("detects persisted repositories that need fresh lockfile or registry inspection", () => {
    const repository = workspaceRepositoryFromInspection(makeRepository("acme", "widgets"));

    expect(repositoryNeedsInspectionRefresh(repository)).toBe(false);

    expect(
      repositoryNeedsInspectionRefresh({
        ...repository,
        dependencyVersions: {}
      })
    ).toBe(false);

    expect(
      repositoryNeedsInspectionRefresh({
        ...repository,
        package: {
          ...repository.package,
          dependencies: [
            {
              packageName: "react",
              currentVersion: "^18.0.0",
              resolvedVersion: null,
              kind: "dependency"
            }
          ]
        }
      })
    ).toBe(true);

    expect(
      repositoryNeedsInspectionRefresh({
        ...repository,
        package: {
          ...repository.package,
          dependencies: [
            {
              packageName: "eslint",
              currentVersion: "^9.0.0",
              resolvedVersion: "9.39.4",
              kind: "devDependency"
            }
          ]
        },
        dependencyVersions: {
          eslint: {
            packageName: "eslint",
            latestVersion: null,
            currentComparableVersion: "9.39.4",
            changeType: "unavailable",
            lookupStatus: "unavailable",
            reason: "Latest version has not been checked."
          }
        }
      })
    ).toBe(true);

    expect(
      repositoryNeedsInspectionRefresh({
        ...repository,
        package: {
          ...repository.package,
          packageManager: {
            ...repository.package.packageManager,
            lockfile: null
          }
        }
      })
    ).toBe(true);
  });

  it("filters dependencies by search, dev type, and available update status", () => {
    const dependencies = toWorkspaceDependencies(
      [
        {
          packageName: "react",
          currentVersion: "^19.0.0",
          resolvedVersion: null,
          kind: "dependency"
        },
        {
          packageName: "vitest",
          currentVersion: "^4.0.0",
          resolvedVersion: null,
          kind: "devDependency"
        }
      ],
      {
        react: {
          packageName: "react",
          latestVersion: "19.0.1",
          currentComparableVersion: "19.0.0",
          changeType: "patch",
          lookupStatus: "found",
          reason: null
        }
      }
    );

    expect(filterDependencies({ dependencies, filter: "dev", query: "" })).toEqual([
      dependencies[1]
    ]);
    expect(filterDependencies({ dependencies, filter: "all", query: "rea" })).toEqual([
      dependencies[0]
    ]);
    expect(filterDependencies({ dependencies, filter: "major", query: "" })).toEqual([]);
    expect(filterDependencies({ dependencies, filter: "updates", query: "" })).toEqual([
      dependencies[0]
    ]);
  });
});

function makeWorkspaceRepository(owner: string, name: string): WorkspaceRepository {
  return workspaceRepositoryFromInspection(makeRepository(owner, name));
}

function makeRepository(owner: string, name: string): RepositoryInspection {
  return {
    metadata: {
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      description: `${name} repo`,
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
      dependencies: [],
      scripts: {}
    }
  };
}
