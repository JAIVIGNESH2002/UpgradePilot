import semver from "semver";

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

export function isNormalRegistryDependency(dependency: DependencyInventoryItem): boolean {
  const spec = dependency.currentVersion.trim();

  return (
    spec !== "" &&
    !spec.startsWith("git+") &&
    !spec.startsWith("github:") &&
    !spec.startsWith("file:") &&
    !spec.startsWith("workspace:") &&
    !spec.startsWith("link:") &&
    !spec.startsWith("npm:")
  );
}

export function classifySemverChange(
  currentVersion: string,
  latestVersion: string
): DependencyChangeType {
  const current = normalizeSemver(currentVersion);
  const latest = normalizeSemver(latestVersion);

  if (current === null || latest === null) {
    return "unavailable";
  }

  if (semver.compare(latest, current) <= 0) {
    return "current";
  }

  const difference = semver.diff(current, latest);

  if (difference === "major" || difference === "premajor") {
    return "major";
  }

  if (difference === "minor" || difference === "preminor") {
    return "minor";
  }

  return "patch";
}

export function comparableCurrentVersion(dependency: DependencyInventoryItem): string | null {
  if (dependency.resolvedVersion !== null) {
    return normalizeSemver(dependency.resolvedVersion);
  }

  return normalizeExactDeclaredVersion(dependency.currentVersion);
}

function normalizeExactDeclaredVersion(input: string): string | null {
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

  if (trimmed !== semver.valid(trimmed)) {
    return null;
  }

  return normalizeSemver(trimmed);
}

function normalizeSemver(input: string): string | null {
  return semver.clean(input);
}
