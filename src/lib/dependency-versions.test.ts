import { describe, expect, it } from "vitest";

import {
  classifySemverChange,
  comparableCurrentVersion,
  enrichDependencyVersion
} from "@/lib/dependency-versions";

describe("dependency version comparison", () => {
  it("classifies current, patch, minor, and major changes", () => {
    expect(classifySemverChange("1.2.3", "1.2.3")).toBe("current");
    expect(classifySemverChange("1.2.3", "1.2.4")).toBe("patch");
    expect(classifySemverChange("1.2.3", "1.3.0")).toBe("minor");
    expect(classifySemverChange("1.2.3", "2.0.0")).toBe("major");
  });

  it("uses resolved versions before declared ranges", () => {
    expect(
      comparableCurrentVersion({
        packageName: "react",
        currentVersion: "^18.0.0",
        resolvedVersion: "18.3.1",
        kind: "dependency"
      })
    ).toBe("18.3.1");
  });

  it("safely handles ranges and non-standard dependency specs", () => {
    expect(
      comparableCurrentVersion({
        packageName: "react",
        currentVersion: "^18.0.0",
        resolvedVersion: null,
        kind: "dependency"
      })
    ).toBe("18.0.0");
    expect(
      comparableCurrentVersion({
        packageName: "local-package",
        currentVersion: "file:../local-package",
        resolvedVersion: null,
        kind: "dependency"
      })
    ).toBeNull();
    expect(
      comparableCurrentVersion({
        packageName: "broad-range",
        currentVersion: ">=1.0.0 <2",
        resolvedVersion: null,
        kind: "dependency"
      })
    ).toBeNull();
  });

  it("enriches dependency versions from registry results", () => {
    expect(
      enrichDependencyVersion(
        {
          packageName: "react",
          currentVersion: "^18.0.0",
          resolvedVersion: "18.3.1",
          kind: "dependency"
        },
        { status: "found", packageName: "react", latestVersion: "19.0.0" }
      )
    ).toMatchObject({
      latestVersion: "19.0.0",
      currentComparableVersion: "18.3.1",
      changeType: "major",
      lookupStatus: "found"
    });
  });

  it("marks registry failures and non-comparable specs as unavailable", () => {
    expect(
      enrichDependencyVersion(
        {
          packageName: "missing",
          currentVersion: "^1.0.0",
          resolvedVersion: null,
          kind: "dependency"
        },
        { status: "unavailable", packageName: "missing", reason: "registry failed" }
      )
    ).toMatchObject({
      latestVersion: null,
      changeType: "unavailable",
      lookupStatus: "unavailable",
      reason: "registry failed"
    });

    expect(
      enrichDependencyVersion(
        {
          packageName: "local-package",
          currentVersion: "file:../local-package",
          resolvedVersion: null,
          kind: "dependency"
        },
        { status: "found", packageName: "local-package", latestVersion: "1.0.0" }
      )
    ).toMatchObject({
      latestVersion: "1.0.0",
      changeType: "unavailable",
      reason: "Current dependency spec is not a comparable semver version."
    });
  });
});
