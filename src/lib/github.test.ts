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
});
