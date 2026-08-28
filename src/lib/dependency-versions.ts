import type { DependencyInventoryItem } from "@/lib/package-inspection";
import type { NpmPackageLatestResult } from "@/lib/npm-registry";

export type DependencyChangeType = "current" | "patch" | "minor" | "major" | "unavailable";

export type DependencyVersionInfo = {
  packageName: string;
  latestVersion: string | null;
  currentComparableVersion: string | null;
  changeType: DependencyChangeType;
  lookupStatus: "found" | "unavailable";
  reason: string | null;
};

export function enrichDependencyVersion(
  dependency: DependencyInventoryItem,
  latestResult: NpmPackageLatestResult | undefined
): DependencyVersionInfo {
  if (latestResult === undefined || latestResult.status === "unavailable") {
    return {
      packageName: dependency.packageName,
      latestVersion: null,
      currentComparableVersion: comparableCurrentVersion(dependency),
      changeType: "unavailable",
      lookupStatus: "unavailable",
      reason: latestResult?.reason ?? "Latest version has not been checked."
    };
  }

  const currentComparableVersion = comparableCurrentVersion(dependency);

  if (currentComparableVersion === null) {
    return {
      packageName: dependency.packageName,
      latestVersion: latestResult.latestVersion,
      currentComparableVersion: null,
      changeType: "unavailable",
      lookupStatus: "found",
      reason: "Current dependency spec is not a comparable semver version."
    };
  }

  return {
    packageName: dependency.packageName,
    latestVersion: latestResult.latestVersion,
    currentComparableVersion,
    changeType: classifySemverChange(currentComparableVersion, latestResult.latestVersion),
    lookupStatus: "found",
    reason: null
  };
}

export function classifySemverChange(
  currentVersion: string,
  latestVersion: string
): DependencyChangeType {
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);

  if (current === null || latest === null) {
    return "unavailable";
  }

  if (
    latest.major < current.major ||
    (latest.major === current.major && latest.minor < current.minor) ||
    (latest.major === current.major &&
      latest.minor === current.minor &&
      latest.patch <= current.patch)
  ) {
    return "current";
  }

  if (latest.major > current.major) {
    return "major";
  }

  if (latest.minor > current.minor) {
    return "minor";
  }

  return "patch";
}

export function comparableCurrentVersion(dependency: DependencyInventoryItem): string | null {
  if (dependency.resolvedVersion !== null) {
    return normalizeSemver(dependency.resolvedVersion);
  }

  return normalizeDeclaredSemverRange(dependency.currentVersion);
}

function normalizeDeclaredSemverRange(input: string): string | null {
  const trimmed = input.trim();

  if (
    trimmed === "" ||
    trimmed.startsWith("git+") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("workspace:") ||
    trimmed.startsWith("link:") ||
    trimmed.startsWith("npm:")
  ) {
    return null;
  }

  if (trimmed.includes(" ") || trimmed.includes("||") || /^[<>]/.test(trimmed)) {
    return null;
  }

  const cleaned = trimmed.replace(/^[~^=v\s]+/, "");

  return cleaned ? normalizeSemver(cleaned) : null;
}

function normalizeSemver(input: string): string | null {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);

  if (match === null) {
    return null;
  }

  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function parseSemver(input: string): { major: number; minor: number; patch: number } | null {
  const normalized = normalizeSemver(input);

  if (normalized === null) {
    return null;
  }

  const [major, minor, patch] = normalized.split(".").map(Number);

  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }

  return { major, minor, patch };
}
