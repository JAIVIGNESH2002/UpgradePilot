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
  const resolvedVersions =
    packageLock !== null
      ? extractNpmResolvedVersions(packageLock)
      : extractPnpmResolvedVersions(pnpmLockText);

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

function extractPnpmResolvedVersions(pnpmLockText: string | null): Map<string, string> {
  const resolvedVersions = new Map<string, string>();

  if (pnpmLockText === null) {
    return resolvedVersions;
  }

  const lines = pnpmLockText.split(/\r?\n/);
  const rootImporterIndex = lines.findIndex((line, index) => {
    const trimmed = line.trim();
    const previousLines = lines.slice(0, index);
    const hasImporters = previousLines.some((previousLine) => previousLine.trim() === "importers:");

    return hasImporters && (trimmed === ".:" || trimmed === "'.':" || trimmed === '".":');
  });

  if (rootImporterIndex === -1) {
    return resolvedVersions;
  }

  const rootIndent = leadingSpaces(lines[rootImporterIndex] ?? "");

  for (let index = rootImporterIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const lineIndent = leadingSpaces(line);

    if (lineIndent <= rootIndent) {
      break;
    }

    const sectionMatch = line.match(
      /^(\s*)(dependencies|devDependencies|optionalDependencies):\s*$/
    );

    if (sectionMatch === null) {
      continue;
    }

    const sectionIndent = sectionMatch[1]?.length ?? 0;
    index = readPnpmImporterDependencySection(lines, index + 1, sectionIndent, resolvedVersions);
  }

  return resolvedVersions;
}

function readPnpmImporterDependencySection(
  lines: string[],
  startIndex: number,
  sectionIndent: number,
  resolvedVersions: Map<string, string>
): number {
  let currentPackageName: string | null = null;
  const packageIndent = sectionIndent + 2;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const lineIndent = leadingSpaces(line);

    if (lineIndent <= sectionIndent) {
      return index - 1;
    }

    if (lineIndent === packageIndent) {
      const packageName = parseYamlMapKey(line.trim());

      if (packageName !== null) {
        currentPackageName = packageName;
      }

      continue;
    }

    if (currentPackageName !== null && lineIndent > packageIndent) {
      const version = parsePnpmVersionLine(line.trim());

      if (version !== null) {
        resolvedVersions.set(currentPackageName, version);
      }
    }
  }

  return lines.length - 1;
}

function parseYamlMapKey(trimmedLine: string): string | null {
  const match = trimmedLine.match(/^(['"]?)(.+?)\1:\s*$/);

  return match?.[2] ?? null;
}

function parsePnpmVersionLine(trimmedLine: string): string | null {
  const match = trimmedLine.match(/^version:\s*(.+?)\s*$/);

  if (match === null) {
    return null;
  }

  const value = unquoteYamlScalar(match[1] ?? "");
  const version = value.split("(")[0]?.trim();

  return version === "" || version === undefined ? null : version;
}

function unquoteYamlScalar(input: string): string {
  const trimmed = input.trim();
  const quote = trimmed[0];

  if ((quote === "'" || quote === '"') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function leadingSpaces(input: string): number {
  return input.length - input.trimStart().length;
}
