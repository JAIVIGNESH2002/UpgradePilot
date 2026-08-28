export type NpmRegistryClientOptions = {
  fetchImpl?: typeof fetch;
  concurrency?: number;
};

export type NpmPackageLatestResult =
  | {
      status: "found";
      packageName: string;
      latestVersion: string;
    }
  | {
      status: "unavailable";
      packageName: string;
      reason: string;
    };

type NpmPackageResponse = {
  "dist-tags"?: {
    latest?: unknown;
  };
};

export class NpmRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NpmRegistryError";
  }
}

export class NpmRegistryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly concurrency: number;
  private readonly cache = new Map<string, Promise<NpmPackageLatestResult>>();

  constructor(options: NpmRegistryClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.concurrency = Math.max(1, options.concurrency ?? 8);
  }

  async getLatestVersions(packageNames: string[]): Promise<Map<string, NpmPackageLatestResult>> {
    const uniquePackageNames = [...new Set(packageNames)].sort((left, right) =>
      left.localeCompare(right)
    );
    const results = new Map<string, NpmPackageLatestResult>();

    for (let index = 0; index < uniquePackageNames.length; index += this.concurrency) {
      const batch = uniquePackageNames.slice(index, index + this.concurrency);
      const batchResults = await Promise.all(
        batch.map(async (packageName) => this.getLatestVersion(packageName))
      );

      for (const result of batchResults) {
        results.set(result.packageName, result);
      }
    }

    return results;
  }

  async getLatestVersion(packageName: string): Promise<NpmPackageLatestResult> {
    const cached = this.cache.get(packageName);

    if (cached !== undefined) {
      return cached;
    }

    const request = this.fetchLatestVersion(packageName);
    this.cache.set(packageName, request);
    return request;
  }

  private async fetchLatestVersion(packageName: string): Promise<NpmPackageLatestResult> {
    try {
      const response = await this.fetchImpl(
        `https://registry.npmjs.org/${encodeNpmPackageName(packageName)}`,
        {
          headers: {
            Accept: "application/vnd.npm.install-v1+json",
            "User-Agent": "UpgradePilot"
          },
          cache: "no-store"
        }
      );

      if (!response.ok) {
        return {
          status: "unavailable",
          packageName,
          reason: `npm registry returned ${response.status}.`
        };
      }

      const body = (await response.json()) as NpmPackageResponse;
      const latestVersion = body["dist-tags"]?.latest;

      if (typeof latestVersion !== "string" || latestVersion.trim() === "") {
        return {
          status: "unavailable",
          packageName,
          reason: "npm registry response did not include a latest dist-tag."
        };
      }

      return { status: "found", packageName, latestVersion };
    } catch (error) {
      return {
        status: "unavailable",
        packageName,
        reason: error instanceof Error ? error.message : "npm registry request failed."
      };
    }
  }
}

function encodeNpmPackageName(packageName: string): string {
  return encodeURIComponent(packageName);
}
