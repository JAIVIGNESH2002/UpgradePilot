import { describe, expect, it, vi } from "vitest";

import { inspectPublicNpmRepository } from "@/lib/repository-inspection";

describe("inspectPublicNpmRepository", () => {
  it("fetches GitHub metadata and root npm files", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href === "https://api.github.com/repos/acme/widgets") {
        return Response.json({
          name: "widgets",
          owner: { login: "acme" },
          html_url: "https://github.com/acme/widgets",
          description: "Useful widgets",
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-27T10:00:00Z"
        });
      }

      if (href === "https://api.github.com/repos/acme/widgets/contents/package.json?ref=main") {
        return new Response(
          JSON.stringify({
            name: "widgets",
            dependencies: { react: "^19.0.0" },
            scripts: { test: "vitest run" }
          })
        );
      }

      if (
        href === "https://api.github.com/repos/acme/widgets/contents/package-lock.json?ref=main"
      ) {
        return new Response(
          JSON.stringify({
            lockfileVersion: 3,
            packages: { "node_modules/react": { version: "19.2.0" } }
          })
        );
      }

      return new Response("not found", { status: 404 });
    });

    const inspection = await inspectPublicNpmRepository("https://github.com/acme/widgets", {
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(inspection.metadata).toMatchObject({
      owner: "acme",
      name: "widgets",
      description: "Useful widgets",
      defaultBranch: "main",
      language: "TypeScript"
    });
    expect(inspection.package.dependencies).toEqual([
      {
        packageName: "react",
        currentVersion: "^19.0.0",
        resolvedVersion: "19.2.0",
        kind: "dependency"
      }
    ]);
    expect(inspection.package.hasPackageLock).toBe(true);
  });

  it("fetches pnpm lockfiles when an npm lockfile is not present", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href === "https://api.github.com/repos/acme/pnpm-demo") {
        return Response.json({
          name: "pnpm-demo",
          owner: { login: "acme" },
          html_url: "https://github.com/acme/pnpm-demo",
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-27T10:00:00Z"
        });
      }

      if (href === "https://api.github.com/repos/acme/pnpm-demo/contents/package.json?ref=main") {
        return new Response(JSON.stringify({ packageManager: "pnpm@10.0.0" }));
      }

      if (href === "https://api.github.com/repos/acme/pnpm-demo/contents/pnpm-lock.yaml?ref=main") {
        return new Response("lockfileVersion: '9.0'");
      }

      return new Response("not found", { status: 404 });
    });

    const inspection = await inspectPublicNpmRepository("https://github.com/acme/pnpm-demo", {
      fetchImpl: fetchImpl as typeof fetch
    });

    expect(inspection.package.packageManager).toMatchObject({
      name: "pnpm",
      lockfile: { type: "pnpm", path: "pnpm-lock.yaml" },
      support: "supported"
    });
  });

  it("fails when a repository has no root package.json", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);

      if (href === "https://api.github.com/repos/acme/no-node") {
        return Response.json({
          name: "no-node",
          owner: { login: "acme" },
          html_url: "https://github.com/acme/no-node",
          description: null,
          default_branch: "main",
          language: null,
          updated_at: "2026-08-27T10:00:00Z"
        });
      }

      return new Response("not found", { status: 404 });
    });

    await expect(
      inspectPublicNpmRepository("https://github.com/acme/no-node", {
        fetchImpl: fetchImpl as typeof fetch
      })
    ).rejects.toThrow("root package.json");
  });
});
