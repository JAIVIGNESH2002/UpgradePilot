export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
};

export type GitHubRepositoryMetadata = GitHubRepositoryRef & {
  description: string | null;
  defaultBranch: string;
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
  updated_at: string;
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
      updatedAt: response.updated_at
    };
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
      return null;
    }

    if (!response.ok) {
      throw new GitHubRepositoryError(`GitHub returned ${response.status} while fetching ${path}.`);
    }

    return response.text();
  }

  private async requestJson<T>(url: string): Promise<T> {
    const response = await this.fetchGitHub(url, {
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
