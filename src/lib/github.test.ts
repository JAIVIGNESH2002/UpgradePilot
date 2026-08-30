import { describe, expect, it, vi } from "vitest";

import { GitHubClient, parseGitHubRepositoryUrl } from "@/lib/github";

describe("parseGitHubRepositoryUrl", () => {
  it("extracts owner and repository name from a public GitHub URL", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/openai/codex")).toEqual({
      owner: "openai",
      name: "codex",
      url: "https://github.com/openai/codex"
    });
  });

  it("normalizes .git suffixes", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      name: "widgets",
      url: "https://github.com/acme/widgets"
    });
  });

  it("rejects non-repository URLs", () => {
    expect(() => parseGitHubRepositoryUrl("https://github.com/acme/widgets/issues")).toThrow(
      "Use a repository URL"
    );
  });
});

describe("GitHubClient", () => {
  it("maps repository metadata from GitHub", async () => {
    const fetchImpl = async () =>
      Response.json({
        name: "widgets",
        owner: { login: "acme" },
        html_url: "https://github.com/acme/widgets",
        description: "Useful widgets",
        default_branch: "main",
        language: "TypeScript",
        updated_at: "2026-08-27T10:00:00Z"
      });
    const client = new GitHubClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(
      client.getRepositoryMetadata({
        owner: "acme",
        name: "widgets",
        url: "https://github.com/acme/widgets"
      })
    ).resolves.toEqual({
      owner: "acme",
      name: "widgets",
      url: "https://github.com/acme/widgets",
      description: "Useful widgets",
      defaultBranch: "main",
      language: "TypeScript",
      updatedAt: "2026-08-27T10:00:00Z"
    });
  });

  it("returns an actionable message when outbound network access is blocked", async () => {
    const fetchImpl = async () => {
      const error = new TypeError("fetch failed");
      Object.defineProperty(error, "cause", {
        value: { code: "EACCES" }
      });
      throw error;
    };
    const client = new GitHubClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(
      client.getRepositoryMetadata({
        owner: "acme",
        name: "widgets",
        url: "https://github.com/acme/widgets"
      })
    ).rejects.toThrow("outbound network access is blocked");
  });

  it("falls back to raw GitHub URLs when contents file fetches fail", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const href = String(url);

      if (href.includes("api.github.com")) {
        return new Response("forbidden", { status: 403 });
      }

      if (href === "https://raw.githubusercontent.com/acme/widgets/main/pnpm-lock.yaml") {
        return new Response("lockfileVersion: '9.0'");
      }

      return new Response("not found", { status: 404 });
    };
    const client = new GitHubClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(
      client.getRepositoryFileText(
        {
          owner: "acme",
          name: "widgets",
          url: "https://github.com/acme/widgets"
        },
        "pnpm-lock.yaml",
        "main"
      )
    ).resolves.toBe("lockfileVersion: '9.0'");
  });

  it("omits sha when creating new files in upgrade pull requests", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url: href, body });

      if (href === "https://api.github.com/repos/acme/widgets") {
        return Response.json({
          name: "widgets",
          owner: { login: "acme" },
          html_url: "https://github.com/acme/widgets",
          description: null,
          default_branch: "main",
          language: "TypeScript",
          updated_at: "2026-08-27T10:00:00Z"
        });
      }

      if (href.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: "base-sha" } });
      }

      if (href.endsWith("/git/refs") && method === "POST") {
        return Response.json({});
      }

      if (href.endsWith("/contents/package.json?ref=main")) {
        return Response.json({ sha: "package-sha" });
      }

      if (href.endsWith("/contents/src/new-helper.ts?ref=main")) {
        return new Response("not found", { status: 404 });
      }

      if (href.endsWith("/contents/package.json") && method === "PUT") {
        return Response.json({});
      }

      if (href.endsWith("/contents/src/new-helper.ts") && method === "PUT") {
        return Response.json({});
      }

      if (href.endsWith("/pulls")) {
        return Response.json({ html_url: "https://github.com/acme/widgets/pull/1", number: 1 });
      }

      return new Response("not found", { status: 404 });
    });
    const client = new GitHubClient({ token: "server-token", fetchImpl: fetchImpl as typeof fetch });

    await client.createPullRequest({
      repositoryUrl: "https://github.com/acme/widgets",
      branchName: "upgradepilot/demo",
      title: "chore: upgrade demo",
      body: "Verified.",
      files: [
        { path: "package.json", content: "{}\n" },
        { path: "src/new-helper.ts", content: "export {}\n" }
      ]
    });

    const updateRequest = requests.find((request) =>
      request.url.endsWith("/contents/package.json")
    );
    const createRequest = requests.find((request) =>
      request.url.endsWith("/contents/src/new-helper.ts")
    );

    expect(updateRequest?.body).toMatchObject({ sha: "package-sha" });
    expect(createRequest?.body).not.toHaveProperty("sha");
  });
});
