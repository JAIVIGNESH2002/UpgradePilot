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
        dependencies: { "@scope/pkg": "^1.0.0", react: "^19.0.0" },
        devDependencies: { vitest: "^4.0.0" }
      }),
      packageLockText: null,
      pnpmLockText: [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      '@scope/pkg':",
        "        specifier: ^1.0.0",
        "        version: 1.2.3(react@19.2.0)",
        "      react:",
        "        specifier: ^19.0.0",
        "        version: 19.2.0",
        "    devDependencies:",
        "      vitest:",
        "        specifier: ^4.0.0",
        "        version: 4.1.0"
      ].join("\n")
    });

    expect(inspection.packageManager).toMatchObject({
      name: "pnpm",
      declared: "pnpm@10.0.0",
      lockfile: { type: "pnpm", path: "pnpm-lock.yaml" },
      support: "supported",
      installCommand: "pnpm install --frozen-lockfile"
    });
    expect(inspection.hasPackageLock).toBe(false);
    expect(inspection.dependencies).toEqual([
      {
        packageName: "@scope/pkg",
        currentVersion: "^1.0.0",
        resolvedVersion: "1.2.3",
        kind: "dependency"
      },
      {
        packageName: "react",
        currentVersion: "^19.0.0",
        resolvedVersion: "19.2.0",
        kind: "dependency"
      },
      {
        packageName: "vitest",
        currentVersion: "^4.0.0",
        resolvedVersion: "4.1.0",
        kind: "devDependency"
      }
    ]);
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

  it("caps dependency and script inventory sizes", () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [`pkg-${index}`, "1.0.0"])
    );
    const scripts = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`script-${index}`, "echo ok"])
    );
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({ dependencies, scripts }),
      packageLockText: null
    });

    expect(inspection.dependencies).toHaveLength(500);
    expect(Object.keys(inspection.scripts)).toHaveLength(100);
  });

  it("applies the dependency inventory cap after combining dependency sections", () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `dep-${index.toString().padStart(3, "0")}`,
        "1.0.0"
      ])
    );
    const devDependencies = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `dev-${index.toString().padStart(3, "0")}`,
        "1.0.0"
      ])
    );
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({ dependencies, devDependencies }),
      packageLockText: null
    });

    expect(inspection.dependencies).toHaveLength(500);
    expect(
      inspection.dependencies.filter((dependency) => dependency.kind === "dependency")
    ).toHaveLength(400);
    expect(
      inspection.dependencies.filter((dependency) => dependency.kind === "devDependency")
    ).toHaveLength(100);
  });

  it("caps scripts by accepted string entries only", () => {
    const scripts = Object.fromEntries([
      ...Array.from({ length: 100 }, (_, index) => [`ignored-${index}`, false]),
      ...Array.from({ length: 100 }, (_, index) => [`script-${index}`, "echo ok"])
    ]);
    const inspection = inspectPackageFiles({
      packageJsonText: JSON.stringify({ scripts }),
      packageLockText: null
    });

    expect(Object.keys(inspection.scripts)).toHaveLength(100);
    expect(inspection.scripts["script-99"]).toBe("echo ok");
  });

  it("rejects oversized package fields", () => {
    expect(() =>
      inspectPackageFiles({
        packageJsonText: JSON.stringify({ name: "x".repeat(501) }),
        packageLockText: null
      })
    ).toThrow("package name is too large");
  });
});
