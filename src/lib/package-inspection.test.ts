import { describe, expect, it } from "vitest";

import { inspectPackageFiles } from "@/lib/package-inspection";

describe("inspectPackageFiles", () => {
  it("extracts package metadata and dependency inventory", () => {
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({
        name: "demo",
        engines: { node: ">=22" },
        packageManager: "npm@10.9.0",
        dependencies: {
          react: "^19.0.0"
        },
        devDependencies: {
          vitest: "^4.0.0"
        },
        scripts: {
          test: "vitest run",
          build: "next build"
        }
      }),
      packageLockText: JSON.stringify({
        lockfileVersion: 3
      })
    });

    expect(inspection).toMatchObject({
      packageName: "demo",
      nodeRequirement: ">=22",
      packageManager: "npm@10.9.0",
      hasPackageLock: true,
      lockfileVersion: 3,
      scripts: {
        test: "vitest run",
        build: "next build"
      }
    });
    expect(inspection.dependencies).toEqual([
      { packageName: "react", currentVersion: "^19.0.0", kind: "dependency" },
      { packageName: "vitest", currentVersion: "^4.0.0", kind: "devDependency" }
    ]);
  });

  it("handles missing lockfiles and dependency sections", () => {
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({ name: "minimal" }),
      packageLockText: null
    });

    expect(inspection.hasPackageLock).toBe(false);
    expect(inspection.lockfileVersion).toBeNull();
    expect(inspection.dependencies).toEqual([]);
    expect(inspection.scripts).toEqual({});
  });

  it("throws a useful error for malformed package metadata", () => {
    expect(() =>
      inspectPackageFiles({
        packageJsonText: "{",
        packageLockText: null
      })
    ).toThrow("Could not parse package.json");
  });
});
