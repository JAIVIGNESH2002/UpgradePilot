export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
};

export type GitHubRepositoryMetadata = GitHubRepositoryRef & {
  description: string | null;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
};

type GitHubRepositoryApiResponse = {
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  html_url: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  updated_at: string;
};

type GitHubRefResponse = {
  object: {
    sha: string;
  };
};

type GitHubContentResponse = {
  sha: string;
};

type GitHubPullRequestResponse = {
  html_url: string;
  number: number;
};

export type GitHubPullRequestInput = {
  repositoryUrl: string;
  branchName: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
};

export type GitHubPullRequestResult = {
  url: string;
  number: number;
  branchName: string;
};

export class GitHubRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubRepositoryError";
  }
}

export function parseGitHubRepositoryUrl(input: string): GitHubRepositoryRef {
  let url: URL;

  try {
    url = new URL(input);
  } catch (error) {
    throw new GitHubRepositoryError("Enter a valid GitHub repository URL.", { cause: error });
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new GitHubRepositoryError("Only github.com repository URLs are supported.");
  }

  const [owner, name, ...rest] = url.pathname.split("/").filter(Boolean);

  if (owner === undefined || name === undefined || rest.length > 0) {
    throw new GitHubRepositoryError("Use a repository URL like https://github.com/owner/repo.");
  }

  return {
    owner,
    name: name.endsWith(".git") ? name.slice(0, -4) : name,
    url: `https://github.com/${owner}/${name.endsWith(".git") ? name.slice(0, -4) : name}`
  };
}

export type GitHubClientOptions = {
  token?: string;
  fetchImpl?: typeof fetch;
};

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly token?: string;

  constructor(options: GitHubClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.token;
  }

  async getRepositoryMetadata(ref: GitHubRepositoryRef): Promise<GitHubRepositoryMetadata> {
    const response = await this.requestJson<GitHubRepositoryApiResponse>(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`
    );

    return {
      owner: response.owner.login,
      name: response.name,
      url: response.html_url,
      description: response.description,
      defaultBranch: response.default_branch,
      language: response.language,
      updatedAt: response.updated_at
    };
  }

  async createPullRequest(input: GitHubPullRequestInput): Promise<GitHubPullRequestResult> {
    if (this.token === undefined || this.token.trim() === "") {
      throw new GitHubRepositoryError("GITHUB_TOKEN is required to create a pull request.");
    }

    const ref = parseGitHubRepositoryUrl(input.repositoryUrl);
    const metadata = await this.getRepositoryMetadata(ref);
    const baseRef = await this.requestJson<GitHubRefResponse>(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
        ref.name
      )}/git/ref/heads/${encodeURIComponent(metadata.defaultBranch)}`
    );

    await this.requestJson(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
        ref.name
      )}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${input.branchName}`,
          sha: baseRef.object.sha
        })
      }
    );

    for (const file of input.files) {
      const existingFile = await this.getRepositoryContent(file.path, {
        owner: ref.owner,
        name: ref.name,
        branch: metadata.defaultBranch
      });
      const body: {
        message: string;
        content: string;
        branch: string;
        sha?: string;
      } = {
        message: `chore: verify ${input.title}`,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch: input.branchName
      };

      if (existingFile !== null) {
        body.sha = existingFile.sha;
      }

      await this.requestJson(
        `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
          ref.name
        )}/contents/${encodeRepositoryPath(file.path)}`,
        {
          method: "PUT",
          body: JSON.stringify(body)
        }
      );
    }

    const pullRequest = await this.requestJson<GitHubPullRequestResponse>(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
        ref.name
      )}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.branchName,
          base: metadata.defaultBranch
        })
      }
    );

    return {
      url: pullRequest.html_url,
      number: pullRequest.number,
      branchName: input.branchName
    };
  }

  private async getRepositoryContent(
    path: string,
    input: { owner: string; name: string; branch: string }
  ): Promise<GitHubContentResponse | null> {
    const response = await this.fetchGitHub(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
        input.name
      )}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(input.branch)}`,
      {
        headers: this.headers({ accept: "application/vnd.github+json" }),
        cache: "no-store"
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new GitHubRepositoryError(
        `GitHub returned ${response.status} while fetching ${path}.`
      );
    }

    return response.json() as Promise<GitHubContentResponse>;
  }

  async getRepositoryFileText(
    ref: GitHubRepositoryRef,
    path: string,
    branch: string
  ): Promise<string | null> {
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.name
    )}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

    const response = await this.fetchGitHub(url, {
      headers: this.headers({ accept: "application/vnd.github.raw" }),
      cache: "no-store"
    });

    if (response.status === 404) {
      return this.getRawRepositoryFileText(ref, path, branch);
    }

    if (!response.ok) {
      const rawText = await this.getRawRepositoryFileText(ref, path, branch);

      if (rawText !== null) {
        return rawText;
      }

      throw new GitHubRepositoryError(`GitHub returned ${response.status} while fetching ${path}.`);
    }

    return response.text();
  }

  private async getRawRepositoryFileText(
    ref: GitHubRepositoryRef,
    path: string,
    branch: string
  ): Promise<string | null> {
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(
      ref.owner
    )}/${encodeURIComponent(ref.name)}/${encodeURIComponent(branch)}/${encodedPath}`;
    const response = await this.fetchGitHub(url, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "UpgradePilot"
      },
      cache: "no-store"
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new GitHubRepositoryError(`GitHub returned ${response.status} while fetching ${path}.`);
    }

    return response.text();
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchGitHub(url, {
      ...init,
      headers: this.headers({ accept: "application/vnd.github+json" }),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new GitHubRepositoryError(`GitHub returned ${response.status} for ${url}.`);
    }

    return response.json() as Promise<T>;
  }

  private headers({ accept }: { accept: string }): HeadersInit {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "UpgradePilot"
    };

    if (this.token !== undefined && this.token.trim() !== "") {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }

  private async fetchGitHub(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw new GitHubRepositoryError(describeGitHubNetworkFailure(error), { cause: error });
    }
  }
}

function encodeRepositoryPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function describeGitHubNetworkFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

  if (causeCode === "EACCES") {
    return "The UpgradePilot server could not reach GitHub because outbound network access is blocked for this local process.";
  }

  if (causeCode === "ENOTFOUND") {
    return "The UpgradePilot server could not resolve GitHub. Check DNS or network connectivity.";
  }

  if (causeCode === "ECONNREFUSED" || causeCode === "ETIMEDOUT") {
    return "The UpgradePilot server could not connect to GitHub. Check network connectivity and retry.";
  }

  return error instanceof Error
    ? `The UpgradePilot server could not fetch data from GitHub: ${error.message}.`
    : "The UpgradePilot server could not fetch data from GitHub.";
}
