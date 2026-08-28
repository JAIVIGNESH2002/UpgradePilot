import { describe, expect, it } from "vitest";

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
});
