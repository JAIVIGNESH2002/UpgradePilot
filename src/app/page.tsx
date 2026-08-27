import { AlertCircle, CheckCircle2, Clock3, GitBranch, Package, Play } from "lucide-react";

import { inspectRepositoryAction, runBaselineAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { getBaselineRun } from "@/lib/baseline-store";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";
import { TrueForgeClient } from "@/lib/trueforge";
import {
  discoverVerificationPlan,
  listMissingVerificationScripts,
  type BaselineVerificationResult,
  type CommandResult
} from "@/lib/verification";

type HomeProps = {
  searchParams: Promise<{ repo?: string | string[] }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const repositoryUrl = Array.isArray(params.repo) ? params.repo[0] : params.repo;
  const inspectionState = repositoryUrl
    ? await loadRepositoryInspection(repositoryUrl)
    : { status: "idle" as const };
  const trueForgeState = await loadTrueForgeState();

  if (inspectionState.status === "loaded") {
    const dependencies = inspectionState.inspection.package.dependencies;
    const verificationPlan = discoverVerificationPlan(inspectionState.inspection.package.scripts);
    const missingScripts = listMissingVerificationScripts(
      inspectionState.inspection.package.scripts
    );
    const baseline = getBaselineRun(repositoryUrl ?? "");

    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
          <HeaderForm defaultRepositoryUrl={repositoryUrl} />

          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-8">
              <RepositoryHeader inspection={inspectionState.inspection} />
              <DependencyInventory dependencies={dependencies} />
            </div>

            <aside className="space-y-4">
              <TrueForgePanel state={trueForgeState} />
              <BaselinePanel
                repositoryUrl={repositoryUrl ?? ""}
                baseline={baseline}
                verificationPlan={verificationPlan}
                missingScripts={missingScripts}
              />
            </aside>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-6 py-16">
        <div className="space-y-10">
          <div className="space-y-4">
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">MVP</p>
            <h1 className="text-4xl font-semibold tracking-normal text-balance sm:text-6xl">
              UpgradePilot
            </h1>
            <p className="max-w-3xl text-lg leading-8 text-muted-foreground">
              Inspect public npm repositories, understand dependency health, and prepare verified
              upgrade runs through isolated sandbox evidence.
            </p>
          </div>

          <HeaderForm defaultRepositoryUrl={repositoryUrl} />

          {inspectionState.status === "error" ? (
            <Notice tone="danger" title="Repository inspection failed">
              {inspectionState.message}
            </Notice>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function HeaderForm({ defaultRepositoryUrl }: { defaultRepositoryUrl?: string }) {
  return (
    <form action={inspectRepositoryAction} className="flex flex-col gap-3 sm:flex-row">
      <label className="sr-only" htmlFor="repositoryUrl">
        Public GitHub npm repository URL
      </label>
      <input
        id="repositoryUrl"
        name="repositoryUrl"
        type="url"
        required
        defaultValue={defaultRepositoryUrl}
        placeholder="https://github.com/owner/repository"
        className="min-h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <Button type="submit">
        <GitBranch className="size-4" aria-hidden="true" />
        Inspect repository
      </Button>
    </form>
  );
}

function RepositoryHeader({
  inspection
}: {
  inspection: Awaited<ReturnType<typeof inspectPublicNpmRepository>>;
}) {
  const packageInfo = inspection.package;

  return (
    <section className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Package className="size-4" aria-hidden="true" />
            {inspection.metadata.owner}
          </span>
          <span className="inline-flex items-center gap-2">
            <GitBranch className="size-4" aria-hidden="true" />
            {inspection.metadata.defaultBranch}
          </span>
          <span>Updated {formatDate(inspection.metadata.updatedAt)}</span>
        </div>
        <div>
          <h2 className="text-3xl font-semibold tracking-normal">{inspection.metadata.name}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {inspection.metadata.description ?? "No repository description provided."}
          </p>
        </div>
      </div>

      <dl className="grid gap-4 border-y border-border py-4 sm:grid-cols-4">
        <MetadataItem label="Package" value={packageInfo.packageName ?? "Unnamed"} />
        <MetadataItem label="Node" value={packageInfo.nodeRequirement ?? "Not declared"} />
        <MetadataItem
          label="Lockfile"
          value={packageInfo.hasPackageLock ? "package-lock" : "Missing"}
        />
        <MetadataItem
          label="Package manager"
          value={packageInfo.packageManager ?? "npm inferred"}
        />
      </dl>
    </section>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

function DependencyInventory({
  dependencies
}: {
  dependencies: Awaited<ReturnType<typeof inspectPublicNpmRepository>>["package"]["dependencies"];
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Dependencies</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Current versions are read from the root package manifest. Latest-version lookup is a
            separate boundary and is not faked.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">{dependencies.length} packages</span>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-secondary text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Package</th>
              <th className="px-4 py-3 font-medium">Current</th>
              <th className="px-4 py-3 font-medium">Recommended/Latest</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {dependencies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No dependencies or devDependencies were found.
                </td>
              </tr>
            ) : (
              dependencies.map((dependency) => (
                <tr
                  key={`${dependency.kind}:${dependency.packageName}`}
                  className="border-t border-border"
                >
                  <td className="px-4 py-3 font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Package className="size-4 text-muted-foreground" aria-hidden="true" />
                      {dependency.packageName}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {dependency.kind === "dependency" ? "runtime" : "dev"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{dependency.currentVersion}</td>
                  <td className="px-4 py-3 text-muted-foreground">Not checked</td>
                  <td className="px-4 py-3">
                    <StatusText tone="neutral">Inventory only</StatusText>
                  </td>
                  <td className="px-4 py-3">
                    <Button type="button" variant="outline" size="sm" disabled>
                      Verify upgrade
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrueForgePanel({
  state
}: {
  state:
    | { status: "ready"; version: string; sandboxProvider: string }
    | { status: "unavailable"; message: string };
}) {
  return (
    <section className="rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">TrueForge</h2>
      {state.status === "ready" ? (
        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
          <p className="flex items-center gap-2 text-foreground">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Connected to {state.version}
          </p>
          <p>Sandbox provider: {state.sandboxProvider}</p>
        </div>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{state.message}</p>
      )}
    </section>
  );
}

function BaselinePanel({
  repositoryUrl,
  baseline,
  verificationPlan,
  missingScripts
}: {
  repositoryUrl: string;
  baseline: ReturnType<typeof getBaselineRun>;
  verificationPlan: ReturnType<typeof discoverVerificationPlan>;
  missingScripts: ReturnType<typeof listMissingVerificationScripts>;
}) {
  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Baseline verification</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Runs npm install and available quality scripts in deterministic order.
          </p>
        </div>
        <form action={runBaselineAction}>
          <input type="hidden" name="repositoryUrl" value={repositoryUrl} />
          <Button type="submit" size="sm">
            <Play className="size-4" aria-hidden="true" />
            Run
          </Button>
        </form>
      </div>

      <div className="mt-4 space-y-3">
        <CommandPlan verificationPlan={verificationPlan} missingScripts={missingScripts} />
        {baseline.status === "NOT_RUN" ? (
          <Notice tone="neutral" title="Not run">
            Baseline verification has not been attempted for this repository.
          </Notice>
        ) : null}
        {baseline.status === "BLOCKED" ? (
          <Notice tone="warning" title="Blocked">
            {baseline.message}
          </Notice>
        ) : null}
        {baseline.status === "COMPLETED" ? <BaselineResult result={baseline.result} /> : null}
      </div>
    </section>
  );
}

function CommandPlan({
  verificationPlan,
  missingScripts
}: {
  verificationPlan: ReturnType<typeof discoverVerificationPlan>;
  missingScripts: ReturnType<typeof listMissingVerificationScripts>;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Command plan
      </p>
      <ol className="space-y-1 text-sm">
        <li className="font-mono text-xs">npm ci</li>
        {verificationPlan.map((step) => (
          <li key={step.scriptName} className="font-mono text-xs">
            {step.command}
          </li>
        ))}
      </ol>
      {missingScripts.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Missing scripts skipped: {missingScripts.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function BaselineResult({ result }: { result: BaselineVerificationResult }) {
  return (
    <div className="space-y-3">
      <StatusText tone={result.status === "PASSED" ? "success" : "danger"}>
        Baseline {result.status.toLowerCase()}
      </StatusText>
      <CommandResultList results={[result.install, ...result.verification]} />
    </div>
  );
}

function CommandResultList({ results }: { results: CommandResult[] }) {
  return (
    <ul className="space-y-2">
      {results.map((result) => (
        <li key={result.command} className="rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-mono text-xs">{result.command}</span>
            <span className="text-xs text-muted-foreground">
              exit {result.exitCode} | {result.durationMs}ms
            </span>
          </div>
          {result.output ? (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {result.output}
            </pre>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Notice({
  tone,
  title,
  children
}: {
  tone: "neutral" | "warning" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "neutral" ? Clock3 : AlertCircle;

  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}

function StatusText({
  tone,
  children
}: {
  tone: "neutral" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const toneClassName =
    tone === "success"
      ? "text-green-700"
      : tone === "danger"
        ? "text-red-700"
        : tone === "warning"
          ? "text-amber-700"
          : "text-muted-foreground";

  return <span className={`text-sm font-medium ${toneClassName}`}>{children}</span>;
}

async function loadRepositoryInspection(repositoryUrl: string) {
  try {
    const inspection = await inspectPublicNpmRepository(repositoryUrl, {
      token: process.env.GITHUB_TOKEN
    });

    return { status: "loaded" as const, inspection };
  } catch (error) {
    return {
      status: "error" as const,
      message: error instanceof Error ? error.message : "Repository inspection failed."
    };
  }
}

async function loadTrueForgeState() {
  try {
    const client = new TrueForgeClient();
    const health = await client.getHealth();
    const sandboxProvider = await client.getSandboxProviderStatus();

    return {
      status: "ready" as const,
      version: health.version,
      sandboxProvider: sandboxProvider
        ? `${sandboxProvider.type} (${sandboxProvider.status})`
        : "Not configured"
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      message: error instanceof Error ? error.message : "TrueForge is unavailable."
    };
  }
}

function formatDate(input: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium"
  }).format(new Date(input));
}
