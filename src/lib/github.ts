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
  private: boolean;
  visibility?: string;
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

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const metadataCache = new Map<string, { expiresAt: number; value: GitHubRepositoryMetadata }>();
const fileCache = new Map<string, { expiresAt: number; value: string | null }>();

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
    const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.name
    )}`;
    const cached = readCache(metadataCache, url);

    if (cached !== undefined) {
      return cached;
    }

    const response = validateRepositoryApiResponse(
      await this.requestJson<unknown>(url, {}, { maxBytes: MAX_JSON_BYTES })
    );

    if (response.private || response.visibility === "private") {
      throw new GitHubRepositoryError("Only public GitHub repositories are supported.");
    }

    const metadata = {
      owner: response.owner.login,
      name: response.name,
      url: response.html_url,
      description: response.description,
      defaultBranch: response.default_branch,
      language: response.language,
      updatedAt: response.updated_at
    };

    writeCache(metadataCache, url, metadata);

    return metadata;
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
      const existingFile = await this.requestJson<GitHubContentResponse>(
        `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
          ref.name
        )}/contents/${encodeRepositoryPath(file.path)}?ref=${encodeURIComponent(
          metadata.defaultBranch
        )}`
      );
      await this.requestJson(
        `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
          ref.name
        )}/contents/${encodeRepositoryPath(file.path)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: `chore: verify ${input.title}`,
            content: Buffer.from(file.content, "utf8").toString("base64"),
            branch: input.branchName,
            sha: existingFile.sha
          })
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
    const cacheKey = `${this.token ? "auth" : "anon"}:${url}`;
    const cached = readCache(fileCache, cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const response = await this.fetchGitHub(url, {
      headers: this.headers({ accept: "application/vnd.github.raw" }),
      cache: "force-cache",
      next: { revalidate: 300 }
    });

    if (response.status === 404) {
      const rawText = await this.getRawRepositoryFileText(ref, path, branch);
      writeCache(fileCache, cacheKey, rawText);

      return rawText;
    }

    if (!response.ok) {
      const rawText = await this.getRawRepositoryFileText(ref, path, branch);

      if (rawText !== null) {
        writeCache(fileCache, cacheKey, rawText);

        return rawText;
      }

      throw new GitHubRepositoryError(`GitHub returned ${response.status} while fetching ${path}.`);
    }

    const text = await readResponseTextWithLimit(response, MAX_FILE_BYTES, path);
    writeCache(fileCache, cacheKey, text);

    return text;
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
      cache: "force-cache",
      next: { revalidate: 300 }
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new GitHubRepositoryError(`GitHub returned ${response.status} while fetching ${path}.`);
    }

    return readResponseTextWithLimit(response, MAX_FILE_BYTES, path);
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
    options: { maxBytes?: number } = {}
  ): Promise<T> {
    const response = await this.fetchGitHub(url, {
      ...init,
      headers: this.headers({ accept: "application/vnd.github+json" }),
      cache: init.method ? "no-store" : "force-cache",
      next: init.method ? undefined : { revalidate: 300 }
    });

    if (!response.ok) {
      throw new GitHubRepositoryError(`GitHub returned ${response.status} for ${url}.`);
    }

    const text = await readResponseTextWithLimit(response, options.maxBytes ?? MAX_JSON_BYTES, url);

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new GitHubRepositoryError("GitHub returned a malformed JSON response.", {
        cause: error
      });
    }
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

function validateRepositoryApiResponse(input: unknown): GitHubRepositoryApiResponse {
  if (!isRecord(input) || !isRecord(input.owner)) {
    throw new GitHubRepositoryError("GitHub returned malformed repository metadata.");
  }

  const repository = input as Record<string, unknown>;
  const owner = input.owner as Record<string, unknown>;

  if (
    typeof repository.name !== "string" ||
    typeof repository.private !== "boolean" ||
    typeof owner.login !== "string" ||
    typeof repository.html_url !== "string" ||
    typeof repository.default_branch !== "string" ||
    typeof repository.updated_at !== "string" ||
    (repository.description !== null && typeof repository.description !== "string") ||
    (repository.language !== null && typeof repository.language !== "string") ||
    (repository.visibility !== undefined && typeof repository.visibility !== "string")
  ) {
    throw new GitHubRepositoryError("GitHub returned malformed repository metadata.");
  }

  return input as GitHubRepositoryApiResponse;
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  const contentLength = response.headers.get("content-length");

  if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new GitHubRepositoryError(`${label} is too large to inspect safely.`);
  }

  if (!response.body) {
    const text = await response.text();
    throwIfTooLarge(text, maxBytes, label);

    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new GitHubRepositoryError(`${label} is too large to inspect safely.`);
    }

    chunks.push(value);
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

function throwIfTooLarge(text: string, maxBytes: number, label: string) {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new GitHubRepositoryError(`${label} is too large to inspect safely.`);
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readCache<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string
): T | undefined {
  const cached = cache.get(key);

  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

function writeCache<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;

    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
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
