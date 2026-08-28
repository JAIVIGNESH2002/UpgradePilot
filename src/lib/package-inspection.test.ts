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
        lockfileVersion: 3,
        packages: {
          "node_modules/react": { version: "19.2.0" }
        }
      })
    });

    expect(inspection).toMatchObject({
      packageName: "demo",
      nodeRequirement: ">=22",
      packageManager: {
        name: "npm",
        declared: "npm@10.9.0",
        lockfile: { type: "npm", path: "package-lock.json", version: 3 },
        support: "supported",
        installCommand: "npm ci"
      },
      hasPackageLock: true,
      lockfileVersion: 3,
      scripts: {
        test: "vitest run",
        build: "next build"
      }
    });
    expect(inspection.dependencies).toEqual([
      {
        packageName: "react",
        currentVersion: "^19.0.0",
        resolvedVersion: "19.2.0",
        kind: "dependency"
      },
      {
        packageName: "vitest",
        currentVersion: "^4.0.0",
        resolvedVersion: null,
        kind: "devDependency"
      }
    ]);
  });

  it("detects pnpm lockfiles and package-manager-specific install commands", () => {
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({
        name: "demo",
        packageManager: "pnpm@10.0.0",
        dependencies: { react: "^19.0.0" }
      }),
      packageLockText: null,
      pnpmLockText: "lockfileVersion: '9.0'"
    });

    expect(inspection.packageManager).toMatchObject({
      name: "pnpm",
      declared: "pnpm@10.0.0",
      lockfile: { type: "pnpm", path: "pnpm-lock.yaml" },
      support: "supported",
      installCommand: "pnpm install --frozen-lockfile"
    });
    expect(inspection.hasPackageLock).toBe(false);
  });

  it("detects Yarn and Bun as recognized but unsupported", () => {
    expect(
      inspectPackageFiles({
        packageJsonText: JSON.stringify({ name: "yarn-demo", packageManager: "yarn@4.0.0" }),
        packageLockText: null,
        yarnLockText: "lock"
      }).packageManager
    ).toMatchObject({
      name: "yarn",
      lockfile: { type: "yarn", path: "yarn.lock" },
      support: "unsupported",
      installCommand: null
    });

    expect(
      inspectPackageFiles({
        packageJsonText: JSON.stringify({ name: "bun-demo", packageManager: "bun@1.0.0" }),
        packageLockText: null,
        bunLockText: "lock"
      }).packageManager
    ).toMatchObject({
      name: "bun",
      lockfile: { type: "bun", path: "bun.lock" },
      support: "unsupported",
      installCommand: null
    });
  });

  it("handles missing lockfiles and dependency sections", () => {
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({ name: "minimal" }),
      packageLockText: null
    });

    expect(inspection.hasPackageLock).toBe(false);
    expect(inspection.lockfileVersion).toBeNull();
    expect(inspection.packageManager).toMatchObject({
      name: "unknown",
      lockfile: null,
      support: "unsupported"
    });
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
