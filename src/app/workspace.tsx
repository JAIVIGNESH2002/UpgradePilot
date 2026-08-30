"use client";

import {
  ArrowLeft,
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
  XCircle,
  GitPullRequest
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
import type { UpgradeRunSnapshot, UpgradeRunStep } from "@/lib/upgrade-run-store";
import { cn } from "@/lib/utils";

type AddRepositoryState =
  { status: "idle" } | { status: "loading" } | { status: "error"; message: string };
type BaselineActionState =
  | { status: "idle" }
  | { status: "running"; repositoryId: string; baseline: WorkspaceRepository["baseline"] }
  | { status: "error"; repositoryId: string; message: string };
type UpgradePreparationState =
  | { status: "idle" }
  | { status: "preparing"; dependencyName: string }
  | { status: "ready"; dependencyName: string; message: string }
  | { status: "error"; dependencyName: string; message: string };
type PullRequestState =
  | { status: "idle" }
  | { status: "creating"; runId: string }
  | { status: "error"; runId: string; message: string };
type RepositoryRefreshState =
  | { status: "idle" }
  | { status: "loading"; repositoryId: string }
  | { status: "error"; repositoryId: string; message: string };
type BaselineRunResponse = {
  run?: {
    id: string;
    repositoryUrl: string;
    status: "running" | "completed";
    baseline: WorkspaceRepository["baseline"];
  };
  message?: string;
};
type UpgradeRunResponse = {
  run?: UpgradeRunSnapshot;
  message?: string;
};

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
  const [activeUpgradeRun, setActiveUpgradeRun] = useState<UpgradeRunSnapshot | null>(null);
  const [pullRequestState, setPullRequestState] = useState<PullRequestState>({ status: "idle" });
  const [verifiedUpgradeKeys, setVerifiedUpgradeKeys] = useState<Set<string>>(new Set());
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
    setActiveUpgradeRun((currentRun) =>
      currentRun !== null &&
      repositories.some(
        (repository) =>
          repository.id === repositoryIdToRemove &&
          repository.repositoryUrl === currentRun.repositoryUrl
      )
        ? null
        : currentRun
    );
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

  function handleSelectRepository(repositoryId: string) {
    setActiveUpgradeRun(null);
    setSelectedRepositoryId(repositoryId);
  }

  async function runBaseline(repository: WorkspaceRepository) {
    try {
      const startResponse = await fetch("/api/repositories/baseline/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: repository.repositoryUrl })
      });
      const startedRun = await parseBaselineRunResponse(startResponse);

      if (startedRun.status === "completed") {
        setRepositoryBaseline(repository.id, startedRun.baseline);
        setBaselineActionState({ status: "idle" });
        return startedRun.baseline;
      }

      setBaselineActionState({
        status: "running",
        repositoryId: repository.id,
        baseline: startedRun.baseline
      });

      let currentRun = startedRun;

      while (currentRun.status === "running") {
        await wait(1000);
        const statusResponse = await fetch(
          `/api/repositories/baseline/runs/status?runId=${encodeURIComponent(currentRun.id)}`
        );
        currentRun = await parseBaselineRunResponse(statusResponse);

        if (currentRun.status === "running") {
          setBaselineActionState({
            status: "running",
            repositoryId: repository.id,
            baseline: currentRun.baseline
          });
        }
      }

      setRepositoryBaseline(repository.id, currentRun.baseline);
      setBaselineActionState({ status: "idle" });
      return currentRun.baseline;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Baseline verification failed to start.";
      setBaselineActionState({ status: "error", repositoryId: repository.id, message });
      return null;
    }
  }

  function setRepositoryBaseline(repositoryId: string, baseline: WorkspaceRepository["baseline"]) {
    setRepositories((currentRepositories) =>
      currentRepositories.map((currentRepository) =>
        currentRepository.id === repositoryId
          ? { ...currentRepository, baseline }
          : currentRepository
      )
    );
  }

  async function prepareVerifyUpgrade(
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency
  ) {
    setUpgradePreparationState({ status: "preparing", dependencyName: dependency.packageName });

    try {
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

      if (
        dependency.latestVersion === null ||
        dependency.currentComparableVersion === null ||
        (dependency.changeType !== "patch" &&
          dependency.changeType !== "minor" &&
          dependency.changeType !== "major")
      ) {
        setUpgradePreparationState({
          status: "error",
          dependencyName: dependency.packageName,
          message: "A resolved current version and newer registry target are required."
        });
        return;
      }

      if (
        repository.package.packageManager.name !== "npm" &&
        repository.package.packageManager.name !== "pnpm"
      ) {
        setUpgradePreparationState({
          status: "error",
          dependencyName: dependency.packageName,
          message: "Only npm and pnpm upgrade verification is supported."
        });
        return;
      }

      const startedRun = await startUpgradeRun({
        repositoryUrl: repository.repositoryUrl,
        packageName: dependency.packageName,
        currentVersion: dependency.currentComparableVersion,
        targetVersion: dependency.latestVersion,
        changeType: dependency.changeType,
        baseline,
        packageManager: repository.package.packageManager.name
      });

      setActiveUpgradeRun(startedRun);
      markVerifiedUpgrade(repository, dependency, startedRun);

      if (startedRun.status === "running") {
        void pollUpgradeRun(startedRun.id, repository.id);
      }

      setUpgradePreparationState({
        status: "ready",
        dependencyName: dependency.packageName,
        message: `${dependency.packageName} upgrade run started for ${dependency.currentComparableVersion} to ${dependency.latestVersion}.`
      });
    } catch (error) {
      setUpgradePreparationState({
        status: "error",
        dependencyName: dependency.packageName,
        message: error instanceof Error ? error.message : "Upgrade run failed to start."
      });
    }
  }

  async function parseBaselineRunResponse(response: Response) {
    const body = (await response.json()) as BaselineRunResponse;

    if (!response.ok || body.run === undefined) {
      throw new Error(body.message ?? "Baseline verification failed to start.");
    }

    return body.run;
  }

  async function startUpgradeRun(input: {
    repositoryUrl: string;
    packageName: string;
    currentVersion: string;
    targetVersion: string;
    changeType: "patch" | "minor" | "major";
    baseline: WorkspaceRepository["baseline"];
    packageManager: "npm" | "pnpm";
  }) {
    const response = await fetch("/api/repositories/upgrade-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });

    return parseUpgradeRunResponse(response);
  }

  async function pollUpgradeRun(runId: string, repositoryId: string) {
    let currentRun: UpgradeRunSnapshot | null = null;

    try {
      while (currentRun?.status !== "completed") {
        await wait(1000);
        const response = await fetch(
          `/api/repositories/upgrade-runs/status?runId=${encodeURIComponent(runId)}`
        );
        currentRun = await parseUpgradeRunResponse(response);
        setActiveUpgradeRun(currentRun);

        if (currentRun.status === "completed" && currentRun.outcome === "verified") {
          const verifiedRun = currentRun;
          setVerifiedUpgradeKeys((currentKeys) => {
            const nextKeys = new Set(currentKeys);
            nextKeys.add(
              upgradeVerificationKey({
                repositoryId,
                packageName: verifiedRun.packageName,
                targetVersion: verifiedRun.targetVersion
              })
            );
            return nextKeys;
          });
        }
      }
    } catch (error) {
      setUpgradePreparationState({
        status: "error",
        dependencyName: "upgrade",
        message: error instanceof Error ? error.message : "Upgrade run status could not be loaded."
      });
    }
  }

  async function createPullRequest(run: UpgradeRunSnapshot) {
    setPullRequestState({ status: "creating", runId: run.id });

    try {
      const response = await fetch("/api/repositories/upgrade-runs/pull-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id })
      });
      const nextRun = await parseUpgradeRunResponse(response);
      setActiveUpgradeRun(nextRun);
      setPullRequestState({ status: "idle" });
    } catch (error) {
      setPullRequestState({
        status: "error",
        runId: run.id,
        message: error instanceof Error ? error.message : "Pull request creation failed."
      });
    }
  }

  async function parseUpgradeRunResponse(response: Response) {
    const body = (await response.json()) as UpgradeRunResponse;

    if (!response.ok || body.run === undefined) {
      throw new Error(body.message ?? "Upgrade run failed to start.");
    }

    return body.run;
  }

  function markVerifiedUpgrade(
    repository: WorkspaceRepository,
    dependency: WorkspaceDependency,
    run: UpgradeRunSnapshot
  ) {
    if (
      run.status !== "completed" ||
      run.outcome !== "verified" ||
      dependency.latestVersion === null
    ) {
      return;
    }

    setVerifiedUpgradeKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      nextKeys.add(
        upgradeVerificationKey({
          repositoryId: repository.id,
          packageName: dependency.packageName,
          targetVersion: dependency.latestVersion
        })
      );
      return nextKeys;
    });
  }

  async function wait(durationMs: number) {
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
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
          onSelectRepository={handleSelectRepository}
        />

        <section className="min-w-0">
          <TopHeader />
          {hasLoadedWorkspace && activeUpgradeRun !== null && selectedRepository !== null ? (
            <UpgradeRunDetail
              repository={selectedRepository}
              run={activeUpgradeRun}
              onBack={() => setActiveUpgradeRun(null)}
              pullRequestState={pullRequestState}
              onCreatePullRequest={createPullRequest}
            />
          ) : hasLoadedWorkspace ? (
            <RepositoryDetail
              repository={selectedRepository}
              query={query}
              filter={filter}
              baselineActionState={baselineActionState}
              repositoryRefreshState={repositoryRefreshState}
              upgradePreparationState={upgradePreparationState}
              verifiedUpgradeKeys={verifiedUpgradeKeys}
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

function UpgradeRunDetail({
  repository,
  run,
  onBack,
  pullRequestState,
  onCreatePullRequest
}: {
  repository: WorkspaceRepository;
  run: UpgradeRunSnapshot;
  onBack: () => void;
  pullRequestState: PullRequestState;
  onCreatePullRequest: (run: UpgradeRunSnapshot) => void;
}) {
  const progressValue = upgradeRunProgressValue(run);
  const isRunning = run.status === "running";
  const canCreatePullRequest =
    run.status === "completed" &&
    run.outcome === "verified" &&
    run.changedFiles.length > 0 &&
    run.pullRequest === null;
  const isCreatingPullRequest =
    pullRequestState.status === "creating" && pullRequestState.runId === run.id;
  const pullRequestError =
    pullRequestState.status === "error" && pullRequestState.runId === run.id
      ? pullRequestState.message
      : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6">
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-3" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to repository
          </Button>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Upgrade run
          </p>
          <h2 className="mt-1 truncate text-2xl font-semibold tracking-normal">
            {run.packageName}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {repository.metadata.owner}/{repository.metadata.name} - {run.currentVersion} to{" "}
            {run.targetVersion}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
            <UpgradeRunStatusIcon run={run} />
            <span className="font-medium">{upgradeRunStatusLabel(run)}</span>
          </div>
          {run.pullRequest ? (
            <Button asChild size="sm" variant="outline">
              <a href={run.pullRequest.url} target="_blank" rel="noreferrer">
                <GitPullRequest className="size-4" aria-hidden="true" />
                PR #{run.pullRequest.number}
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canCreatePullRequest || isCreatingPullRequest}
              onClick={() => onCreatePullRequest(run)}
            >
              {isCreatingPullRequest ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <GitPullRequest className="size-4" aria-hidden="true" />
              )}
              Create PR
            </Button>
          )}
          {pullRequestError ? (
            <p className="max-w-xs text-right text-xs text-destructive">{pullRequestError}</p>
          ) : null}
        </div>
      </div>

      <section className="overflow-hidden rounded-md border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Workflow</h3>
              <p className="mt-1 text-sm text-muted-foreground">{run.message}</p>
            </div>
            <span className="text-xs text-muted-foreground">
              Started {formatRepositoryUpdatedAt(run.startedAt)}
            </span>
          </div>
        </div>
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
          {run.steps.map((step, index) => (
            <li key={`${step.name}:${index}`} className="px-4 py-4">
              <UpgradeRunStepRow step={step} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function UpgradeRunStepRow({ step }: { step: UpgradeRunStep }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <BaselineStepIcon status={step.status} />
          <p className="truncate text-sm font-medium">{step.name}</p>
          <BaselineStepStatus status={step.status} />
        </div>
        {step.command ? (
          <p className="mt-1 truncate pl-6 font-mono text-xs text-muted-foreground">
            {step.command}
          </p>
        ) : null}
        {step.output ? (
          <details className="mt-2 pl-6">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              View output
            </summary>
            <pre className="mt-2 max-h-44 overflow-auto rounded-md border border-border bg-secondary/30 p-3 text-xs leading-5 text-muted-foreground">
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

function UpgradeRunStatusIcon({ run }: { run: UpgradeRunSnapshot }) {
  if (run.status === "running") {
    return <Loader2 className="size-4 animate-spin" aria-hidden="true" />;
  }

  if (run.outcome === "verified") {
    return <CheckCircle2 className="size-4 text-green-600" aria-hidden="true" />;
  }

  if (run.outcome === "blocked" || run.outcome === "interrupted") {
    return <XCircle className="size-4 text-red-600" aria-hidden="true" />;
  }

  return <MinusCircle className="size-4 text-amber-600" aria-hidden="true" />;
}

function RepositoryDetail({
  repository,
  query,
  filter,
  baselineActionState,
  repositoryRefreshState,
  upgradePreparationState,
  verifiedUpgradeKeys,
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
  verifiedUpgradeKeys: Set<string>;
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
        verifiedUpgradeKeys={verifiedUpgradeKeys}
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
  const runningBaseline = isRunning ? baselineActionState.baseline : null;
  const isUnsupported = repository.package.packageManager.support === "unsupported";
  const [isExpanded, setIsExpanded] = useState(false);
  const steps = runningBaseline?.steps ?? repository.baseline.steps;
  const hasSteps = steps.length > 0;
  const progressValue = baselineProgressValue(isRunning, runningBaseline ?? repository.baseline);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const openTimer = window.setTimeout(() => {
      setIsExpanded(true);
    }, 0);

    return () => window.clearTimeout(openTimer);
  }, [isRunning]);

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
  verifiedUpgradeKeys,
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
  verifiedUpgradeKeys: Set<string>;
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
                    isVerified={verifiedUpgradeKeys.has(
                      upgradeVerificationKey({
                        repositoryId: repository.id,
                        packageName: dependency.packageName,
                        targetVersion: dependency.latestVersion
                      })
                    )}
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
  isVerified,
  onPrepareVerifyUpgrade
}: {
  repository: WorkspaceRepository;
  dependency: WorkspaceDependency;
  isVerified: boolean;
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
        {isVerified ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Verified upgrade
          </span>
        ) : hasUpgradeTarget ? (
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

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function baselineProgressValue(isRunning: boolean, baseline: WorkspaceRepository["baseline"]) {
  if (baseline.steps.length === 0) {
    return isRunning ? 8 : 0;
  }

  const settledSteps = baseline.steps.filter(
    (step) => step.status === "passed" || step.status === "failed" || step.status === "skipped"
  ).length;
  const runningStep = baseline.steps.some((step) => step.status === "running") ? 0.65 : 0;
  const progress = ((settledSteps + runningStep) / baseline.steps.length) * 100;

  return Math.min(Math.max(progress, isRunning ? 8 : 0), isRunning ? 96 : 100);
}

function upgradeRunProgressValue(run: UpgradeRunSnapshot) {
  if (run.steps.length === 0) {
    return run.status === "running" ? 8 : 100;
  }

  const settledSteps = run.steps.filter(
    (step) => step.status === "passed" || step.status === "failed" || step.status === "skipped"
  ).length;
  const runningStep = run.steps.some((step) => step.status === "running") ? 0.65 : 0;
  const progress = ((settledSteps + runningStep) / run.steps.length) * 100;

  return Math.min(Math.max(progress, run.status === "running" ? 8 : 0), 100);
}

function upgradeRunStatusLabel(run: UpgradeRunSnapshot) {
  if (run.status === "running") {
    return "Running";
  }

  if (run.outcome === "verified") {
    return "Verified";
  }

  if (run.outcome === "blocked") {
    return "Blocked";
  }

  if (run.outcome === "interrupted") {
    return "Interrupted";
  }

  return "Repair failed";
}

function upgradeVerificationKey({
  repositoryId,
  packageName,
  targetVersion
}: {
  repositoryId: string;
  packageName: string;
  targetVersion: string | null;
}) {
  return `${repositoryId}:${packageName}:${targetVersion ?? "none"}`;
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
