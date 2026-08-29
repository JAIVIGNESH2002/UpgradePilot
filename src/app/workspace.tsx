"use client";

import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  GitBranch,
  Loader2,
  MinusCircle,
  Package,
  Plus,
  Search,
  Trash2,
  XCircle
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DependencyVersionInfo } from "@/lib/dependency-versions";
import type { RepositoryInspection } from "@/lib/package-inspection";
import {
  addOrUpdateRepository,
  filterDependencies,
  formatRepositoryUpdatedAt,
  nextSelectedRepositoryId,
  parseRepositoryWorkspaceSnapshot,
  removeRepository,
  REPOSITORY_WORKSPACE_STORAGE_KEY,
  repositoryNeedsInspectionRefresh,
  serializeRepositoryWorkspaceSnapshot,
  toWorkspaceDependencies,
  workspaceRepositoryFromInspection,
  type DependencyFilter,
  type WorkspaceDependency,
  type WorkspaceBaselineStep,
  type WorkspaceRepository
} from "@/lib/repository-workspace";
import { cn } from "@/lib/utils";
import { VERIFICATION_SCRIPT_ORDER, scriptCommandForPackageManager } from "@/lib/verification";

type AddRepositoryState =
  { status: "idle" } | { status: "loading" } | { status: "error"; message: string };
type BaselineActionState =
  | { status: "idle" }
  | { status: "running"; repositoryId: string }
  | { status: "error"; repositoryId: string; message: string };
type UpgradePreparationState =
  | { status: "idle" }
  | { status: "preparing"; dependencyName: string }
  | { status: "ready"; dependencyName: string; message: string }
  | { status: "error"; dependencyName: string; message: string };
type RepositoryRefreshState =
  | { status: "idle" }
  | { status: "loading"; repositoryId: string }
  | { status: "error"; repositoryId: string; message: string };

const dependencyFilters: Array<{ value: DependencyFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "updates", label: "Updates" },
  { value: "major", label: "Major" },
  { value: "dev", label: "Dev" }
];

export function RepositoryWorkspace() {
  const [repositories, setRepositories] = useState<WorkspaceRepository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [addState, setAddState] = useState<AddRepositoryState>({ status: "idle" });
  const [baselineActionState, setBaselineActionState] = useState<BaselineActionState>({
    status: "idle"
  });
  const [upgradePreparationState, setUpgradePreparationState] = useState<UpgradePreparationState>({
    status: "idle"
  });
  const [repositoryRefreshState, setRepositoryRefreshState] = useState<RepositoryRefreshState>({
    status: "idle"
  });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DependencyFilter>("all");
  const [hasLoadedWorkspace, setHasLoadedWorkspace] = useState(false);
  const refreshAttemptedRepositoryIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const snapshot = parseRepositoryWorkspaceSnapshot(
        window.localStorage.getItem(REPOSITORY_WORKSPACE_STORAGE_KEY)
      );
      setRepositories(snapshot.repositories);
      setSelectedRepositoryId(snapshot.selectedRepositoryId);
      setHasLoadedWorkspace(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hasLoadedWorkspace) {
      return;
    }

    window.localStorage.setItem(
      REPOSITORY_WORKSPACE_STORAGE_KEY,
      serializeRepositoryWorkspaceSnapshot({ repositories, selectedRepositoryId })
    );
  }, [hasLoadedWorkspace, repositories, selectedRepositoryId]);

  useEffect(() => {
    const selectedRepository =
      repositories.find((repository) => repository.id === selectedRepositoryId) ?? null;

    if (
      !hasLoadedWorkspace ||
      selectedRepository === null ||
      !repositoryNeedsInspectionRefresh(selectedRepository) ||
      refreshAttemptedRepositoryIds.current.has(selectedRepository.id)
    ) {
      return;
    }

    const repositoryIdToRefresh = selectedRepository.id;
    const timer = window.setTimeout(() => {
      if (refreshAttemptedRepositoryIds.current.has(repositoryIdToRefresh)) {
        return;
      }

      refreshAttemptedRepositoryIds.current.add(repositoryIdToRefresh);
      void refreshRepository(selectedRepository, { visible: false });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [hasLoadedWorkspace, repositories, selectedRepositoryId]);

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === selectedRepositoryId) ?? null,
    [repositories, selectedRepositoryId]
  );

  async function refreshRepository(
    repository: WorkspaceRepository,
    {
      signal,
      visible
    }: {
      signal?: AbortSignal;
      visible: boolean;
    }
  ) {
    if (visible) {
      setRepositoryRefreshState({ status: "loading", repositoryId: repository.id });
    }

    try {
      const response = await fetch("/api/repositories/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: repository.repositoryUrl }),
        signal
      });
      const body = (await response.json()) as {
        inspection?: RepositoryInspection;
        dependencyVersions?: Record<string, DependencyVersionInfo>;
        message?: string;
      };

      if (!response.ok || body.inspection === undefined) {
        throw new Error(body.message ?? "Repository inspection failed.");
      }

      const refreshedRepository = workspaceRepositoryFromInspection(
        body.inspection,
        body.dependencyVersions ?? {}
      );

      setRepositories((currentRepositories) =>
        currentRepositories.map((currentRepository) =>
          currentRepository.id === repository.id
            ? {
                ...refreshedRepository,
                baseline: currentRepository.baseline
              }
            : currentRepository
        )
      );

      if (visible) {
        setRepositoryRefreshState({ status: "idle" });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      if (visible) {
        setRepositoryRefreshState({
          status: "error",
          repositoryId: repository.id,
          message: error instanceof Error ? error.message : "Repository inspection failed."
        });
      }
    }
  }

  async function handleAddRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedRepositoryUrl = repositoryUrl.trim();

    if (trimmedRepositoryUrl === "") {
      setAddState({ status: "error", message: "Enter a public GitHub repository URL." });
      return;
    }

    setAddState({ status: "loading" });

    try {
      const response = await fetch("/api/repositories/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: trimmedRepositoryUrl })
      });
      const body = (await response.json()) as {
        inspection?: RepositoryInspection;
        dependencyVersions?: Record<string, DependencyVersionInfo>;
        message?: string;
      };

      if (!response.ok || body.inspection === undefined) {
        throw new Error(body.message ?? "Repository inspection failed.");
      }

      const repository = workspaceRepositoryFromInspection(
        body.inspection,
        body.dependencyVersions ?? {}
      );

      setRepositories((currentRepositories) =>
        addOrUpdateRepository(currentRepositories, repository)
      );
      setSelectedRepositoryId(repository.id);
      setRepositoryUrl("");
      setQuery("");
      setFilter("all");
      setUpgradePreparationState({ status: "idle" });
      setAddState({ status: "idle" });
    } catch (error) {
      setAddState({
        status: "error",
        message: error instanceof Error ? error.message : "Repository inspection failed."
      });
    }
  }

  function handleRemoveRepository(repositoryIdToRemove: string) {
    setRepositories((currentRepositories) => {
      const nextRepositories = removeRepository(currentRepositories, repositoryIdToRemove);
      setSelectedRepositoryId((currentSelectedRepositoryId) =>
        nextSelectedRepositoryId({
          repositories: nextRepositories,
          currentSelectedRepositoryId,
          removedRepositoryId: repositoryIdToRemove
        })
      );
      return nextRepositories;
    });
  }

  async function runBaseline(repository: WorkspaceRepository) {
    setBaselineActionState({ status: "running", repositoryId: repository.id });

    try {
      const response = await fetch("/api/repositories/baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: repository.repositoryUrl })
      });
      const body = (await response.json()) as {
        baseline?: WorkspaceRepository["baseline"];
        message?: string;
      };

      if (!response.ok || body.baseline === undefined) {
        throw new Error(body.message ?? "Baseline verification failed to start.");
      }

      const baseline = body.baseline;

      setRepositories((currentRepositories) =>
        currentRepositories.map((currentRepository) =>
          currentRepository.id === repository.id
            ? { ...currentRepository, baseline }
            : currentRepository
        )
      );
      setBaselineActionState({ status: "idle" });
      return baseline;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Baseline verification failed to start.";
      setBaselineActionState({ status: "error", repositoryId: repository.id, message });
      return null;
    }
  }

  async function prepareVerifyUpgrade(
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency
  ) {
    setUpgradePreparationState({ status: "preparing", dependencyName: dependency.packageName });

    const baseline =
      repository.baseline.status === "healthy"
        ? repository.baseline
        : await runBaseline(repository);

    if (baseline?.status !== "healthy") {
      setUpgradePreparationState({
        status: "error",
        dependencyName: dependency.packageName,
        message: "A healthy baseline is required before opening an upgrade run."
      });
      return;
    }

    setUpgradePreparationState({
      status: "ready",
      dependencyName: dependency.packageName,
      message: `${dependency.packageName} can open an upgrade run targeting ${dependency.latestVersion}.`
    });
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
        <RepositorySidebar
          repositories={repositories}
          selectedRepositoryId={selectedRepositoryId}
          repositoryUrl={repositoryUrl}
          addState={addState}
          hasLoadedWorkspace={hasLoadedWorkspace}
          onAddRepository={handleAddRepository}
          onRepositoryUrlChange={setRepositoryUrl}
          onRemoveRepository={handleRemoveRepository}
          onSelectRepository={setSelectedRepositoryId}
        />

        <section className="min-w-0">
          <TopHeader />
          {hasLoadedWorkspace ? (
            <RepositoryDetail
              repository={selectedRepository}
              query={query}
              filter={filter}
              baselineActionState={baselineActionState}
              repositoryRefreshState={repositoryRefreshState}
              upgradePreparationState={upgradePreparationState}
              onQueryChange={setQuery}
              onFilterChange={setFilter}
              onRunBaseline={runBaseline}
              onRefreshRepository={refreshRepository}
              onPrepareVerifyUpgrade={prepareVerifyUpgrade}
            />
          ) : (
            <WorkspaceLoadingState />
          )}
        </section>
      </div>
    </main>
  );
}

function TopHeader() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
          <Package className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">UpgradePilot</h1>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Repository dependencies and verified upgrade preparation
          </p>
        </div>
      </div>
    </header>
  );
}

function RepositorySidebar({
  repositories,
  selectedRepositoryId,
  repositoryUrl,
  addState,
  hasLoadedWorkspace,
  onAddRepository,
  onRepositoryUrlChange,
  onRemoveRepository,
  onSelectRepository
}: {
  repositories: WorkspaceRepository[];
  selectedRepositoryId: string | null;
  repositoryUrl: string;
  addState: AddRepositoryState;
  hasLoadedWorkspace: boolean;
  onAddRepository: (event: FormEvent<HTMLFormElement>) => void;
  onRepositoryUrlChange: (value: string) => void;
  onRemoveRepository: (repositoryId: string) => void;
  onSelectRepository: (repositoryId: string) => void;
}) {
  return (
    <aside className="border-b border-border bg-secondary/35 lg:min-h-screen lg:border-b-0 lg:border-r">
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-4 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Repositories
          </p>
          <form className="mt-3 space-y-2" onSubmit={onAddRepository}>
            <label className="sr-only" htmlFor="repositoryUrl">
              Public GitHub repository URL
            </label>
            <input
              id="repositoryUrl"
              name="repositoryUrl"
              type="url"
              value={repositoryUrl}
              onChange={(event) => onRepositoryUrlChange(event.target.value)}
              placeholder="https://github.com/owner/repo"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button
              className="w-full justify-start"
              type="submit"
              size="sm"
              disabled={addState.status === "loading"}
            >
              {addState.status === "loading" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              {addState.status === "loading" ? "Adding..." : "Add repository"}
            </Button>
          </form>
          {addState.status === "error" ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-background p-3">
              <p className="text-sm font-medium text-destructive">Repository inspection failed</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{addState.message}</p>
            </div>
          ) : null}
        </div>

        <nav className="min-h-0 flex-1 overflow-auto px-2 py-2" aria-label="Connected repositories">
          {!hasLoadedWorkspace ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Loading workspace...</p>
          ) : repositories.length === 0 ? (
            <p className="px-2 py-3 text-sm leading-6 text-muted-foreground">
              Add a public npm repository to keep it in this local workspace.
            </p>
          ) : (
            <ul className="space-y-1">
              {repositories.map((repository) => (
                <li key={repository.id}>
                  <RepositorySidebarItem
                    repository={repository}
                    isSelected={repository.id === selectedRepositoryId}
                    onRemoveRepository={onRemoveRepository}
                    onSelectRepository={onSelectRepository}
                  />
                </li>
              ))}
            </ul>
          )}
        </nav>
      </div>
    </aside>
  );
}

function RepositorySidebarItem({
  repository,
  isSelected,
  onRemoveRepository,
  onSelectRepository
}: {
  repository: WorkspaceRepository;
  isSelected: boolean;
  onRemoveRepository: (repositoryId: string) => void;
  onSelectRepository: (repositoryId: string) => void;
}) {
  return (
    <div
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_28px] items-center gap-1 rounded-md border border-transparent",
        isSelected ? "border-border bg-background shadow-sm" : "hover:bg-background/70"
      )}
    >
      <button
        type="button"
        className="min-w-0 px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-current={isSelected ? "page" : undefined}
        onClick={() => onSelectRepository(repository.id)}
      >
        <span className="flex items-center gap-2">
          <HealthDot status={repository.baseline.status} />
          <span className="truncate text-sm font-medium">{repository.metadata.name}</span>
        </span>
        <span className="mt-0.5 block truncate pl-4 text-xs text-muted-foreground">
          {repository.metadata.owner}
        </span>
      </button>
      <button
        type="button"
        className="mr-1 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-100 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
        aria-label={`Remove ${repository.metadata.owner}/${repository.metadata.name}`}
        onClick={() => onRemoveRepository(repository.id)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function RepositoryDetail({
  repository,
  query,
  filter,
  baselineActionState,
  repositoryRefreshState,
  upgradePreparationState,
  onQueryChange,
  onFilterChange,
  onRunBaseline,
  onRefreshRepository,
  onPrepareVerifyUpgrade
}: {
  repository: WorkspaceRepository | null;
  query: string;
  filter: DependencyFilter;
  baselineActionState: BaselineActionState;
  repositoryRefreshState: RepositoryRefreshState;
  upgradePreparationState: UpgradePreparationState;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: DependencyFilter) => void;
  onRunBaseline: (
    repository: WorkspaceRepository
  ) => Promise<WorkspaceRepository["baseline"] | null>;
  onRefreshRepository: (
    repository: WorkspaceRepository,
    options: { visible: boolean }
  ) => Promise<void>;
  onPrepareVerifyUpgrade: (
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency
  ) => Promise<void>;
}) {
  if (repository === null) {
    return <EmptyWorkspaceState />;
  }

  const dependencies = toWorkspaceDependencies(
    repository.package.dependencies,
    repository.dependencyVersions
  );
  const filteredDependencies = filterDependencies({ dependencies, filter, query });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
      <RepositoryHeader repository={repository} />
      <BaselinePanel
        repository={repository}
        baselineActionState={baselineActionState}
        upgradePreparationState={upgradePreparationState}
        onRunBaseline={onRunBaseline}
      />
      <DependencySurface
        repository={repository}
        dependencies={dependencies}
        filteredDependencies={filteredDependencies}
        query={query}
        filter={filter}
        repositoryRefreshState={repositoryRefreshState}
        onQueryChange={onQueryChange}
        onFilterChange={onFilterChange}
        onRefreshRepository={onRefreshRepository}
        onPrepareVerifyUpgrade={onPrepareVerifyUpgrade}
      />
    </div>
  );
}

function RepositoryHeader({ repository }: { repository: WorkspaceRepository }) {
  return (
    <section className="border-b border-border pb-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <a
              className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              href={repository.metadata.url}
              target="_blank"
              rel="noreferrer"
            >
              {repository.metadata.owner}/{repository.metadata.name}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="size-3.5" aria-hidden="true" />
              {repository.metadata.defaultBranch}
            </span>
            <span>{repository.metadata.language ?? "Language unavailable"}</span>
            <span>Updated {formatRepositoryUpdatedAt(repository.metadata.updatedAt)}</span>
          </div>
          <div>
            <h2 className="truncate text-2xl font-semibold tracking-normal">
              {repository.metadata.name}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {repository.metadata.description ?? "No repository description provided."}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5 lg:grid-cols-3">
          <MetadataItem label="Package" value={repository.package.packageName ?? "Unnamed"} />
          <MetadataItem label="Node" value={repository.package.nodeRequirement ?? "Not declared"} />
          <MetadataItem label="Lockfile" value={lockfileLabel(repository)} />
          <MetadataItem label="Manager" value={packageManagerLabel(repository)} />
          <MetadataItem
            label="Baseline"
            value={statusLabel(repository.baseline.status)}
            status={repository.baseline.status}
          />
        </dl>
      </div>
    </section>
  );
}

function MetadataItem({
  label,
  value,
  status
}: {
  label: string;
  value: string;
  status?: WorkspaceRepository["baseline"]["status"];
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-2 font-medium">
        {status ? <HealthDot status={status} /> : null}
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

function BaselinePanel({
  repository,
  baselineActionState,
  upgradePreparationState,
  onRunBaseline
}: {
  repository: WorkspaceRepository;
  baselineActionState: BaselineActionState;
  upgradePreparationState: UpgradePreparationState;
  onRunBaseline: (
    repository: WorkspaceRepository
  ) => Promise<WorkspaceRepository["baseline"] | null>;
}) {
  const isRunning =
    baselineActionState.status === "running" && baselineActionState.repositoryId === repository.id;
  const isUnsupported = repository.package.packageManager.support === "unsupported";
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const plannedSteps = useMemo(() => baselinePlannedSteps(repository), [repository]);
  const steps = isRunning
    ? runningBaselineSteps(plannedSteps, activeStepIndex)
    : repository.baseline.steps;
  const hasSteps = steps.length > 0;
  const progressValue = isRunning
    ? Math.min(((activeStepIndex + 1) / Math.max(plannedSteps.length, 1)) * 100, 96)
    : repository.baseline.status === "healthy"
      ? 100
      : 0;

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const openTimer = window.setTimeout(() => {
      setIsExpanded(true);
      setActiveStepIndex(0);
    }, 0);
    const timer = window.setInterval(() => {
      setActiveStepIndex((currentIndex) => Math.min(currentIndex + 1, plannedSteps.length - 1));
    }, 1800);

    return () => {
      window.clearTimeout(openTimer);
      window.clearInterval(timer);
    };
  }, [isRunning, plannedSteps.length]);

  return (
    <section className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-sm text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={`Baseline details: ${isRunning ? "Running" : statusLabel(repository.baseline.status)}`}
            aria-expanded={isExpanded}
            aria-controls={`baseline-steps-${repository.id}`}
            onClick={() => setIsExpanded((currentValue) => !currentValue)}
          >
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                isExpanded ? "rotate-0" : "-rotate-90"
              )}
              aria-hidden="true"
            />
            <HealthDot status={isRunning ? "unknown" : repository.baseline.status} />
            <span>Baseline: {isRunning ? "Running" : statusLabel(repository.baseline.status)}</span>
          </button>
          <p className="mt-1 text-sm text-muted-foreground">{baselineDescription(repository)}</p>
          {baselineActionState.status === "error" &&
          baselineActionState.repositoryId === repository.id ? (
            <p className="mt-2 text-sm text-destructive">{baselineActionState.message}</p>
          ) : null}
          {upgradePreparationState.status !== "idle" ? (
            <p
              className={cn(
                "mt-2 text-sm",
                upgradePreparationState.status === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {upgradePreparationMessage(upgradePreparationState)}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant={repository.baseline.status === "unknown" ? "default" : "outline"}
          disabled={isRunning || isUnsupported}
          onClick={() => void onRunBaseline(repository)}
        >
          {isRunning ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {repository.baseline.status === "unknown" ? "Run baseline" : "Re-run baseline"}
        </Button>
      </div>
      {(isExpanded || isRunning) && (hasSteps || isRunning) ? (
        <div
          id={`baseline-steps-${repository.id}`}
          className="border-t border-border bg-secondary/20"
        >
          <div className="h-1 bg-secondary">
            <div
              className={cn(
                "h-full bg-foreground transition-[width] duration-700 ease-out",
                isRunning ? "motion-safe:animate-pulse" : ""
              )}
              style={{ width: `${progressValue}%` }}
            />
          </div>
          <ol className="divide-y divide-border">
            {steps.map((step) => (
              <li key={`${step.name}:${step.command}`} className="px-4 py-3">
                <BaselineStepRow step={step} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function BaselineStepRow({ step }: { step: WorkspaceRepository["baseline"]["steps"][number] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <BaselineStepIcon status={step.status} />
          <p className="truncate text-sm font-medium">{step.name}</p>
          <BaselineStepStatus status={step.status} />
        </div>
        <p className="mt-1 truncate pl-6 font-mono text-xs text-muted-foreground">{step.command}</p>
        {step.output ? (
          <details className="mt-2 pl-6">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              View output
            </summary>
            <pre className="mt-2 max-h-44 overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">
              {step.output}
            </pre>
          </details>
        ) : null}
      </div>
      {step.durationMs !== null ? (
        <span className="pl-6 text-xs text-muted-foreground sm:pl-0">
          {formatDuration(step.durationMs)}
        </span>
      ) : null}
    </div>
  );
}

function BaselineStepIcon({ status }: { status: WorkspaceBaselineStep["status"] }) {
  if (status === "running") {
    return <Loader2 className="size-4 shrink-0 animate-spin text-foreground" aria-hidden="true" />;
  }

  if (status === "passed") {
    return <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-hidden="true" />;
  }

  if (status === "failed") {
    return <XCircle className="size-4 shrink-0 text-red-600" aria-hidden="true" />;
  }

  if (status === "skipped") {
    return <MinusCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }

  return <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function BaselineStepStatus({ status }: { status: WorkspaceBaselineStep["status"] }) {
  const label =
    status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Failed"
        : status === "running"
          ? "Running"
          : status === "skipped"
            ? "Skipped"
            : "Queued";

  return <span className="text-xs text-muted-foreground">{label}</span>;
}

function DependencySurface({
  repository,
  dependencies,
  filteredDependencies,
  query,
  filter,
  repositoryRefreshState,
  onQueryChange,
  onFilterChange,
  onRefreshRepository,
  onPrepareVerifyUpgrade
}: {
  repository: WorkspaceRepository;
  dependencies: WorkspaceDependency[];
  filteredDependencies: WorkspaceDependency[];
  query: string;
  filter: DependencyFilter;
  repositoryRefreshState: RepositoryRefreshState;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: DependencyFilter) => void;
  onRefreshRepository: (
    repository: WorkspaceRepository,
    options: { visible: boolean }
  ) => Promise<void>;
  onPrepareVerifyUpgrade: (
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency
  ) => Promise<void>;
}) {
  const isRefreshing =
    repositoryRefreshState.status === "loading" &&
    repositoryRefreshState.repositoryId === repository.id;
  const refreshError =
    repositoryRefreshState.status === "error" &&
    repositoryRefreshState.repositoryId === repository.id
      ? repositoryRefreshState.message
      : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Dependencies</h2>
          <p className="text-sm text-muted-foreground">
            {dependencies.length} packages from root package.json
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isRefreshing}
            onClick={() => void onRefreshRepository(repository, { visible: true })}
          >
            {isRefreshing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Refresh versions
          </Button>
          <label className="relative block">
            <span className="sr-only">Search dependencies</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search packages"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-56"
            />
          </label>
          <div className="inline-flex h-9 rounded-md border border-border bg-secondary/60 p-0.5">
            {dependencyFilters.map((dependencyFilter) => (
              <button
                key={dependencyFilter.value}
                type="button"
                className={cn(
                  "rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  filter === dependencyFilter.value
                    ? "bg-background text-foreground shadow-sm"
                    : "hover:text-foreground"
                )}
                aria-pressed={filter === dependencyFilter.value}
                onClick={() => onFilterChange(dependencyFilter.value)}
              >
                {dependencyFilter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {refreshError ? <p className="text-sm text-destructive">{refreshError}</p> : null}

      <div className="overflow-hidden rounded-md border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] border-collapse text-sm">
            <thead className="bg-secondary/80 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Package</th>
                <th className="px-4 py-3 font-medium">Current</th>
                <th className="px-4 py-3 font-medium">Latest</th>
                <th className="px-4 py-3 font-medium">Change type/status</th>
                <th className="px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredDependencies.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    {dependencies.length === 0
                      ? "No dependencies or devDependencies were found."
                      : "No dependencies match this view."}
                  </td>
                </tr>
              ) : (
                filteredDependencies.map((dependency) => (
                  <DependencyRow
                    key={`${dependency.kind}:${dependency.packageName}`}
                    repository={repository}
                    dependency={dependency}
                    onPrepareVerifyUpgrade={onPrepareVerifyUpgrade}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function DependencyRow({
  repository,
  dependency,
  onPrepareVerifyUpgrade
}: {
  repository: WorkspaceRepository;
  dependency: WorkspaceDependency;
  onPrepareVerifyUpgrade: (
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency
  ) => Promise<void>;
}) {
  const hasUpgradeTarget =
    dependency.latestVersion !== null &&
    (dependency.changeType === "patch" ||
      dependency.changeType === "minor" ||
      dependency.changeType === "major");

  return (
    <tr className="border-t border-border hover:bg-secondary/35">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate font-medium">{dependency.packageName}</p>
            <p className="text-xs text-muted-foreground">
              {dependency.kind === "dependency" ? "dependency" : "devDependency"}
            </p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <SemverIndicator label="Current" tone="current" />
        <span className="ml-2 font-mono text-xs">
          {dependency.currentComparableVersion ?? dependency.currentVersion}
        </span>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        {dependency.latestVersion ?? "Unavailable"}
      </td>
      <td className="px-4 py-3">
        <SemverIndicator
          label={changeTypeLabel(dependency.changeType)}
          tone={dependency.changeType}
        />
        {dependency.reason ? (
          <span className="ml-2 text-xs text-muted-foreground">{dependency.reason}</span>
        ) : null}
      </td>
      <td className="px-4 py-3">
        {hasUpgradeTarget ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onPrepareVerifyUpgrade(repository, dependency)}
          >
            Verify upgrade
          </Button>
        ) : dependency.changeType === "current" ? (
          <span className="text-sm text-muted-foreground">Current</span>
        ) : (
          <span className="text-sm text-muted-foreground">Unavailable</span>
        )}
      </td>
    </tr>
  );
}

function SemverIndicator({
  label,
  tone
}: {
  label: string;
  tone: "current" | "patch" | "minor" | "major" | "unavailable";
}) {
  const toneClassName =
    tone === "major"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "minor"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : tone === "patch"
          ? "border-green-200 bg-green-50 text-green-700"
          : tone === "current"
            ? "border-border bg-secondary text-foreground"
            : "border-border bg-background text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-sm border px-2 text-xs font-medium",
        toneClassName
      )}
    >
      {label}
    </span>
  );
}

function HealthDot({ status }: { status: WorkspaceRepository["baseline"]["status"] }) {
  const className =
    status === "healthy"
      ? "bg-green-600"
      : status === "failed"
        ? "bg-red-600"
        : status === "interrupted"
          ? "bg-amber-600"
          : "bg-muted-foreground";

  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", className)}
      aria-label={`Baseline ${statusLabel(status)}`}
      role="img"
    />
  );
}

function EmptyWorkspaceState() {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-16">
      <section className="max-w-md text-center">
        <h2 className="text-2xl font-semibold tracking-normal">Add a repository to begin</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Connected public npm repositories will stay in this browser workspace and appear in the
          sidebar.
        </p>
      </section>
    </div>
  );
}

function WorkspaceLoadingState() {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-16">
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading workspace...
      </p>
    </div>
  );
}

function statusLabel(status: WorkspaceRepository["baseline"]["status"]) {
  return status === "healthy"
    ? "Healthy"
    : status === "failed"
      ? "Failed"
      : status === "interrupted"
        ? "Interrupted"
        : "Not run";
}

function changeTypeLabel(changeType: WorkspaceDependency["changeType"]) {
  return changeType === "unavailable"
    ? "Unavailable"
    : changeType.charAt(0).toUpperCase() + changeType.slice(1);
}

function lockfileLabel(repository: WorkspaceRepository) {
  const lockfile = repository.package.packageManager?.lockfile;

  return lockfile === null || lockfile === undefined ? "Missing" : lockfile.path;
}

function packageManagerLabel(repository: WorkspaceRepository) {
  const packageManager = repository.package.packageManager;
  const declaredVersion = packageManager.declared?.split("@").slice(1).join("@");
  const supportSuffix = packageManager.support === "supported" ? "" : " (unsupported)";

  return `${packageManager.name}${declaredVersion ? ` ${declaredVersion}` : ""}${supportSuffix}`;
}

function baselineDescription(repository: WorkspaceRepository) {
  if (repository.package.packageManager.support === "unsupported") {
    return `${repository.package.packageManager.name} was detected, but sandbox execution support is not implemented yet.`;
  }

  if (repository.baseline.status === "unknown") {
    return `Ready to run ${repository.package.packageManager.installCommand ?? "install"} and available checks.`;
  }

  const updatedAt = repository.baseline.updatedAt
    ? ` on ${formatRepositoryUpdatedAt(repository.baseline.updatedAt)}`
    : "";

  if (repository.baseline.status === "healthy") {
    return `Healthy baseline from ${repository.baseline.commands} commands${updatedAt}.`;
  }

  if (repository.baseline.status === "failed") {
    return (
      repository.baseline.message ??
      `Baseline failed after ${repository.baseline.commands} commands${updatedAt}.`
    );
  }

  return repository.baseline.message ?? `Baseline was interrupted${updatedAt}.`;
}

function baselinePlannedSteps(repository: WorkspaceRepository): WorkspaceBaselineStep[] {
  const packageManager = repository.package.packageManager.name;

  if (packageManager !== "npm" && packageManager !== "pnpm") {
    return [];
  }

  const scriptSteps = VERIFICATION_SCRIPT_ORDER.map((scriptName) => ({
    name: verificationScriptLabel(scriptName),
    command: scriptCommandForPackageManager(packageManager, scriptName),
    status:
      repository.package.scripts[scriptName] === undefined
        ? ("skipped" as const)
        : ("pending" as const),
    durationMs: null,
    output:
      repository.package.scripts[scriptName] === undefined
        ? "Script not defined in package.json."
        : null
  }));

  return [
    {
      name: "Install dependencies",
      command: repository.package.packageManager.installCommand ?? "install",
      status: "pending",
      durationMs: null,
      output: null
    },
    ...scriptSteps
  ];
}

function runningBaselineSteps(
  steps: WorkspaceBaselineStep[],
  activeStepIndex: number
): WorkspaceBaselineStep[] {
  return steps.map((step, index) => ({
    ...step,
    status:
      step.status === "skipped" ? "skipped" : index === activeStepIndex ? "running" : "pending"
  }));
}

function verificationScriptLabel(scriptName: string) {
  return scriptName === "format:check"
    ? "Format check"
    : scriptName.charAt(0).toUpperCase() + scriptName.slice(1);
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function upgradePreparationMessage(upgradePreparationState: UpgradePreparationState) {
  if (upgradePreparationState.status === "preparing") {
    return `Preparing ${upgradePreparationState.dependencyName}: checking baseline first.`;
  }

  if (upgradePreparationState.status === "ready" || upgradePreparationState.status === "error") {
    return upgradePreparationState.message;
  }

  return "";
}
