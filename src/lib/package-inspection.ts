import type { GitHubRepositoryMetadata } from "@/lib/github";

export type DependencyKind = "dependency" | "devDependency";

export type DependencyInventoryItem = {
  packageName: string;
  currentVersion: string;
  resolvedVersion: string | null;
  kind: DependencyKind;
};

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type PackageManagerSupport = "supported" | "unsupported";

export type LockfileType = "npm" | "pnpm" | "yarn" | "bun";

export type PackageLockfile = {
  type: LockfileType;
  path: string;
  version: number | null;
};

export type PackageManagerInspection = {
  name: PackageManagerName;
  declared: string | null;
  lockfile: PackageLockfile | null;
  support: PackageManagerSupport;
  installCommand: string | null;
};

export type PackageInspection = {
  packageName: string | null;
  nodeRequirement: string | null;
  packageManager: PackageManagerInspection;
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
  packages?: unknown;
};

export class PackageInspectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackageInspectionError";
  }
}

export function inspectPackageFiles({
  packageJsonText,
  packageLockText,
  pnpmLockText = null,
  yarnLockText = null,
  bunLockText = null
}: {
  packageJsonText: string;
  packageLockText: string | null;
  pnpmLockText?: string | null;
  yarnLockText?: string | null;
  bunLockText?: string | null;
}): PackageInspection {
  const packageJson = parseJson<PackageJsonShape>(packageJsonText, "package.json");
  const packageLock = packageLockText
    ? parseJson<PackageLockShape>(packageLockText, "package-lock.json")
    : null;
  const packageManager = inspectPackageManager({
    declaredPackageManager:
      typeof packageJson.packageManager === "string" ? packageJson.packageManager : null,
    packageLock,
    hasPnpmLock: pnpmLockText !== null,
    hasYarnLock: yarnLockText !== null,
    hasBunLock: bunLockText !== null
  });
  const resolvedVersions = extractNpmResolvedVersions(packageLock);

  return {
    packageName: typeof packageJson.name === "string" ? packageJson.name : null,
    nodeRequirement:
      typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null,
    packageManager,
    hasPackageLock: packageLock !== null,
    lockfileVersion:
      typeof packageLock?.lockfileVersion === "number" ? packageLock.lockfileVersion : null,
    dependencies: [
      ...extractDependencyItems(packageJson.dependencies, "dependency", resolvedVersions),
      ...extractDependencyItems(packageJson.devDependencies, "devDependency", resolvedVersions)
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

function extractDependencyItems(
  input: unknown,
  kind: DependencyKind,
  resolvedVersions: Map<string, string>
): DependencyInventoryItem[] {
  if (!isStringRecord(input)) {
    return [];
  }

  return Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([packageName, currentVersion]) => ({
      packageName,
      currentVersion,
      resolvedVersion: resolvedVersions.get(packageName) ?? null,
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

function inspectPackageManager({
  declaredPackageManager,
  packageLock,
  hasPnpmLock,
  hasYarnLock,
  hasBunLock
}: {
  declaredPackageManager: string | null;
  packageLock: PackageLockShape | null;
  hasPnpmLock: boolean;
  hasYarnLock: boolean;
  hasBunLock: boolean;
}): PackageManagerInspection {
  const declaredName = parseDeclaredPackageManagerName(declaredPackageManager);
  const lockfile =
    packageLock !== null
      ? {
          type: "npm" as const,
          path: "package-lock.json",
          version:
            typeof packageLock.lockfileVersion === "number" ? packageLock.lockfileVersion : null
        }
      : hasPnpmLock
        ? { type: "pnpm" as const, path: "pnpm-lock.yaml", version: null }
        : hasYarnLock
          ? { type: "yarn" as const, path: "yarn.lock", version: null }
          : hasBunLock
            ? { type: "bun" as const, path: "bun.lock", version: null }
            : null;
  const name = declaredName ?? lockfile?.type ?? "unknown";
  const support = name === "npm" || name === "pnpm" ? "supported" : "unsupported";

  return {
    name,
    declared: declaredPackageManager,
    lockfile,
    support,
    installCommand:
      name === "npm" ? "npm ci" : name === "pnpm" ? "pnpm install --frozen-lockfile" : null
  };
}

function parseDeclaredPackageManagerName(input: string | null): PackageManagerName | null {
  const name = input?.split("@")[0]?.trim().toLowerCase();

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return name;
  }

  return null;
}

function extractNpmResolvedVersions(packageLock: PackageLockShape | null): Map<string, string> {
  const resolvedVersions = new Map<string, string>();

  if (!isStringRecord(packageLock?.packages)) {
    return resolvedVersions;
  }

  for (const [path, packageInfo] of Object.entries(packageLock.packages)) {
    if (!path.startsWith("node_modules/") || !isStringRecord(packageInfo)) {
      continue;
    }

    const version = packageInfo.version;
    if (typeof version === "string") {
      resolvedVersions.set(path.replace(/^node_modules\//, ""), version);
    }
  }

  return resolvedVersions;
}
