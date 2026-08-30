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
        owner: { login: "acme" }, private: false,
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

  it("rejects private repositories before file inspection can use the server token", async () => {
    const fetchImpl = async () =>
      Response.json({
        name: "secret",
        owner: { login: "acme" },
        private: true,
        visibility: "private",
        html_url: "https://github.com/acme/secret",
        description: null,
        default_branch: "main",
        language: null,
        updated_at: "2026-08-27T10:00:00Z"
      });
    const client = new GitHubClient({
      token: "server-token",
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(
      client.getRepositoryMetadata({
        owner: "acme",
        name: "secret",
        url: "https://github.com/acme/secret"
      })
    ).rejects.toThrow("Only public GitHub repositories are supported");
  });

  it("surfaces malformed repository metadata explicitly", async () => {
    const client = new GitHubClient({
      fetchImpl: (async () => Response.json({ name: "widgets" })) as typeof fetch
    });

    await expect(
      client.getRepositoryMetadata({
        owner: "acme",
        name: "malformed",
        url: "https://github.com/acme/malformed"
      })
    ).rejects.toThrow("malformed repository metadata");
  });

  it("rejects oversized GitHub file bodies before parsing", async () => {
    const client = new GitHubClient({
      fetchImpl: (async () =>
        new Response("too large", {
          headers: { "content-length": String(3 * 1024 * 1024) }
        })) as typeof fetch
    });

    await expect(
      client.getRepositoryFileText(
        {
          owner: "acme",
          name: "widgets",
          url: "https://github.com/acme/widgets"
        },
        "package-lock.json",
        "main"
      )
    ).rejects.toThrow("too large to inspect safely");
  });

  it("caches successful public file reads for a short ttl", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"name":"widgets"}'));
    const client = new GitHubClient({ fetchImpl: fetchImpl as typeof fetch });
    const ref = {
      owner: "cache-test",
      name: "widgets",
      url: "https://github.com/cache-test/widgets"
    };

    await expect(client.getRepositoryFileText(ref, "package.json", "main")).resolves.toBe(
      '{"name":"widgets"}'
    );
    await expect(client.getRepositoryFileText(ref, "package.json", "main")).resolves.toBe(
      '{"name":"widgets"}'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
        name: "network-blocked",
        url: "https://github.com/acme/network-blocked"
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
});
