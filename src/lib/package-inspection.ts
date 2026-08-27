import type { GitHubRepositoryMetadata } from "@/lib/github";

export type DependencyKind = "dependency" | "devDependency";

export type DependencyInventoryItem = {
  packageName: string;
  currentVersion: string;
  kind: DependencyKind;
};

export type PackageInspection = {
  packageName: string | null;
  nodeRequirement: string | null;
  packageManager: string | null;
  hasPackageLock: boolean;
  lockfileVersion: number | null;
  dependencies: DependencyInventoryItem[];
  scripts: Record<string, string>;
};

export type RepositoryInspection = {
  metadata: GitHubRepositoryMetadata;
  package: PackageInspection;
};

type PackageJsonShape = {
  name?: unknown;
  engines?: {
    node?: unknown;
  };
  packageManager?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
};

type PackageLockShape = {
  lockfileVersion?: unknown;
};

export class PackageInspectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackageInspectionError";
  }
}

export function inspectPackageFiles({
  packageJsonText,
  packageLockText
}: {
  packageJsonText: string;
  packageLockText: string | null;
}): PackageInspection {
  const packageJson = parseJson<PackageJsonShape>(packageJsonText, "package.json");
  const packageLock = packageLockText
    ? parseJson<PackageLockShape>(packageLockText, "package-lock.json")
    : null;

  return {
    packageName: typeof packageJson.name === "string" ? packageJson.name : null,
    nodeRequirement:
      typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null,
    packageManager:
      typeof packageJson.packageManager === "string" ? packageJson.packageManager : null,
    hasPackageLock: packageLock !== null,
    lockfileVersion:
      typeof packageLock?.lockfileVersion === "number" ? packageLock.lockfileVersion : null,
    dependencies: [
      ...extractDependencyItems(packageJson.dependencies, "dependency"),
      ...extractDependencyItems(packageJson.devDependencies, "devDependency")
    ],
    scripts: extractScripts(packageJson.scripts)
  };
}

function parseJson<T>(text: string, fileName: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new PackageInspectionError(`Could not parse ${fileName}.`, { cause: error });
  }
}

function extractDependencyItems(input: unknown, kind: DependencyKind): DependencyInventoryItem[] {
  if (!isStringRecord(input)) {
    return [];
  }

  return Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([packageName, currentVersion]) => ({
      packageName,
      currentVersion,
      kind
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function extractScripts(input: unknown): Record<string, string> {
  if (!isStringRecord(input)) {
    return {};
  }

  return Object.entries(input).reduce<Record<string, string>>((scripts, [name, command]) => {
    if (typeof command === "string") {
      scripts[name] = command;
    }

    return scripts;
  }, {});
}

function isStringRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
