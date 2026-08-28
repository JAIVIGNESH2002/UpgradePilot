import type { DependencyChangeType, DependencyVersionInfo } from "@/lib/dependency-versions";
import type {
  DependencyInventoryItem,
  PackageInspection,
  PackageManagerInspection,
  PackageManagerName,
  RepositoryInspection
} from "@/lib/package-inspection";

export const REPOSITORY_WORKSPACE_STORAGE_KEY = "upgradepilot.repositories.v1";

export type WorkspaceRepositoryStatus = "unknown" | "healthy" | "failed" | "interrupted";

export type WorkspaceBaseline = {
  status: WorkspaceRepositoryStatus;
  updatedAt: string | null;
  commands: number;
  message: string | null;
};

export type WorkspaceRepository = RepositoryInspection & {
  id: string;
  repositoryUrl: string;
  baseline: WorkspaceBaseline;
  dependencyVersions: Record<string, DependencyVersionInfo>;
};

export type RepositoryWorkspaceSnapshot = {
  repositories: WorkspaceRepository[];
  selectedRepositoryId: string | null;
};

export type DependencyFilter = "all" | "updates" | "major" | "dev";

export type WorkspaceDependency = DependencyInventoryItem & {
  latestVersion: string | null;
  currentComparableVersion: string | null;
  changeType: DependencyChangeType;
  lookupStatus: DependencyVersionInfo["lookupStatus"];
  reason: string | null;
};

export function repositoryId(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function workspaceRepositoryFromInspection(
  inspection: RepositoryInspection,
  dependencyVersions: Record<string, DependencyVersionInfo> = {}
): WorkspaceRepository {
  return {
    ...inspection,
    id: repositoryId(inspection.metadata.owner, inspection.metadata.name),
    repositoryUrl: inspection.metadata.url,
    baseline: {
      status: "unknown",
      updatedAt: null,
      commands: 0,
      message: null
    },
    dependencyVersions
  };
}

export function addOrUpdateRepository(
  repositories: WorkspaceRepository[],
  repository: WorkspaceRepository
): WorkspaceRepository[] {
  const nextRepositories = repositories.filter((item) => item.id !== repository.id);
  nextRepositories.push(repository);
  return nextRepositories.sort(compareRepositories);
}

export function removeRepository(
  repositories: WorkspaceRepository[],
  repositoryIdToRemove: string
): WorkspaceRepository[] {
  return repositories.filter((repository) => repository.id !== repositoryIdToRemove);
}

export function nextSelectedRepositoryId({
  repositories,
  currentSelectedRepositoryId,
  removedRepositoryId
}: {
  repositories: WorkspaceRepository[];
  currentSelectedRepositoryId: string | null;
  removedRepositoryId?: string;
}): string | null {
  if (repositories.length === 0) {
    return null;
  }

  if (
    currentSelectedRepositoryId !== null &&
    currentSelectedRepositoryId !== removedRepositoryId &&
    repositories.some((repository) => repository.id === currentSelectedRepositoryId)
  ) {
    return currentSelectedRepositoryId;
  }

  return repositories[0]?.id ?? null;
}

export function toWorkspaceDependencies(
  dependencies: DependencyInventoryItem[],
  dependencyVersions: Record<string, DependencyVersionInfo> = {}
): WorkspaceDependency[] {
  return dependencies.map((dependency) => {
    const versionInfo = dependencyVersions[dependency.packageName];

    return {
      ...dependency,
      latestVersion: versionInfo?.latestVersion ?? null,
      currentComparableVersion: versionInfo?.currentComparableVersion ?? null,
      changeType: versionInfo?.changeType ?? "unavailable",
      lookupStatus: versionInfo?.lookupStatus ?? "unavailable",
      reason: versionInfo?.reason ?? "Latest version has not been checked."
    };
  });
}

export function repositoryNeedsInspectionRefresh(repository: WorkspaceRepository): boolean {
  if (
    repository.package.packageManager.name === "unknown" ||
    repository.package.packageManager.lockfile === null
  ) {
    return true;
  }

  return repository.package.dependencies.some(
    (dependency) => repository.dependencyVersions[dependency.packageName] === undefined
  );
}

export function filterDependencies({
  dependencies,
  filter,
  query
}: {
  dependencies: WorkspaceDependency[];
  filter: DependencyFilter;
  query: string;
}): WorkspaceDependency[] {
  const normalizedQuery = query.trim().toLowerCase();

  return dependencies.filter((dependency) => {
    const matchesQuery =
      normalizedQuery === "" || dependency.packageName.toLowerCase().includes(normalizedQuery);
    const matchesFilter =
      filter === "all" ||
      (filter === "updates" &&
        (dependency.changeType === "patch" ||
          dependency.changeType === "minor" ||
          dependency.changeType === "major")) ||
      (filter === "major" && dependency.changeType === "major") ||
      (filter === "dev" && dependency.kind === "devDependency");

    return matchesQuery && matchesFilter;
  });
}

export function parseRepositoryWorkspaceSnapshot(
  value: string | null
): RepositoryWorkspaceSnapshot {
  if (value === null) {
    return emptyRepositoryWorkspaceSnapshot();
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      return emptyRepositoryWorkspaceSnapshot();
    }

    const candidate = parsed as RepositoryWorkspaceSnapshot;
    const repositories = Array.isArray(candidate.repositories)
      ? candidate.repositories.map(normalizeWorkspaceRepository).filter(isWorkspaceRepository)
      : [];
    const selectedRepositoryId = repositories.some(
      (repository) => repository.id === candidate.selectedRepositoryId
    )
      ? candidate.selectedRepositoryId
      : (repositories[0]?.id ?? null);

    return {
      repositories: repositories.sort(compareRepositories),
      selectedRepositoryId
    };
  } catch {
    return emptyRepositoryWorkspaceSnapshot();
  }
}

export function serializeRepositoryWorkspaceSnapshot(
  snapshot: RepositoryWorkspaceSnapshot
): string {
  return JSON.stringify({
    repositories: snapshot.repositories.sort(compareRepositories),
    selectedRepositoryId: snapshot.selectedRepositoryId
  });
}

export function emptyRepositoryWorkspaceSnapshot(): RepositoryWorkspaceSnapshot {
  return {
    repositories: [],
    selectedRepositoryId: null
  };
}

export function formatRepositoryUpdatedAt(input: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium"
  }).format(new Date(input));
}

function compareRepositories(left: WorkspaceRepository, right: WorkspaceRepository): number {
  return `${left.metadata.owner}/${left.metadata.name}`.localeCompare(
    `${right.metadata.owner}/${right.metadata.name}`
  );
}

function isWorkspaceRepository(input: unknown): input is WorkspaceRepository {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as WorkspaceRepository;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.repositoryUrl === "string" &&
    isWorkspaceBaseline(candidate.baseline) &&
    isDependencyVersionRecord(candidate.dependencyVersions) &&
    typeof candidate.metadata?.owner === "string" &&
    typeof candidate.metadata?.name === "string" &&
    typeof candidate.metadata?.url === "string" &&
    typeof candidate.metadata?.defaultBranch === "string" &&
    typeof candidate.metadata?.updatedAt === "string" &&
    Array.isArray(candidate.package?.dependencies)
  );
}

function normalizeWorkspaceRepository(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const candidate = input as WorkspaceRepository & {
    baselineStatus?: "unknown" | "passed" | "failed" | "blocked";
  };

  return {
    ...candidate,
    package: normalizePackageInspection(candidate.package),
    baseline: isWorkspaceBaseline(candidate.baseline)
      ? candidate.baseline
      : legacyBaseline(candidate.baselineStatus),
    dependencyVersions: candidate.dependencyVersions ?? {}
  };
}

function normalizePackageInspection(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const candidate = input as Partial<PackageInspection> & {
    packageManager?: unknown;
    dependencies?: unknown;
  };

  return {
    ...candidate,
    packageManager: normalizePackageManager(
      candidate.packageManager,
      candidate.hasPackageLock,
      candidate.lockfileVersion
    ),
    dependencies: Array.isArray(candidate.dependencies)
      ? candidate.dependencies.map(normalizeDependency)
      : []
  };
}

function normalizeDependency(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const candidate = input as Partial<DependencyInventoryItem>;

  return {
    ...candidate,
    resolvedVersion:
      typeof candidate.resolvedVersion === "string" ? candidate.resolvedVersion : null
  };
}

function normalizePackageManager(
  input: unknown,
  hasPackageLock: unknown,
  lockfileVersion: unknown
): PackageManagerInspection {
  if (typeof input === "object" && input !== null) {
    const candidate = input as Partial<PackageManagerInspection>;
    const lockfile =
      typeof candidate.lockfile === "object" &&
      candidate.lockfile !== null &&
      typeof candidate.lockfile.path === "string" &&
      (candidate.lockfile.type === "npm" ||
        candidate.lockfile.type === "pnpm" ||
        candidate.lockfile.type === "yarn" ||
        candidate.lockfile.type === "bun")
        ? candidate.lockfile
        : null;
    const storedName = normalizePackageManagerName(candidate.name);
    const name = storedName === "unknown" && lockfile !== null ? lockfile.type : storedName;

    return {
      name,
      declared: typeof candidate.declared === "string" ? candidate.declared : null,
      lockfile,
      support: name === "npm" || name === "pnpm" ? "supported" : "unsupported",
      installCommand:
        typeof candidate.installCommand === "string" &&
        candidate.installCommand === installCommandForPackageManager(name)
          ? candidate.installCommand
          : installCommandForPackageManager(name)
    };
  }

  const declared = typeof input === "string" ? input : null;
  const name = normalizePackageManagerName(declared?.split("@")[0]);

  return {
    name,
    declared,
    lockfile:
      hasPackageLock === true
        ? {
            type: "npm",
            path: "package-lock.json",
            version: typeof lockfileVersion === "number" ? lockfileVersion : null
          }
        : null,
    support: name === "npm" || name === "pnpm" ? "supported" : "unsupported",
    installCommand: installCommandForPackageManager(name)
  };
}

function legacyBaseline(
  status: "unknown" | "passed" | "failed" | "blocked" | undefined
): WorkspaceBaseline {
  return {
    status:
      status === "passed"
        ? "healthy"
        : status === "failed"
          ? "failed"
          : status === "blocked"
            ? "interrupted"
            : "unknown",
    updatedAt: null,
    commands: 0,
    message: null
  };
}

function normalizePackageManagerName(input: unknown): PackageManagerName {
  const name = typeof input === "string" ? input.trim().toLowerCase() : "";

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return name;
  }

  return "unknown";
}

function installCommandForPackageManager(name: PackageManagerName): string | null {
  return name === "npm" ? "npm ci" : name === "pnpm" ? "pnpm install --frozen-lockfile" : null;
}

function isWorkspaceRepositoryStatus(input: unknown): input is WorkspaceRepositoryStatus {
  return (
    input === "unknown" || input === "healthy" || input === "failed" || input === "interrupted"
  );
}

function isWorkspaceBaseline(input: unknown): input is WorkspaceBaseline {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as WorkspaceBaseline;

  return (
    isWorkspaceRepositoryStatus(candidate.status) &&
    (candidate.updatedAt === null || typeof candidate.updatedAt === "string") &&
    typeof candidate.commands === "number" &&
    (candidate.message === null || typeof candidate.message === "string")
  );
}

function isDependencyVersionRecord(input: unknown): input is Record<string, DependencyVersionInfo> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
