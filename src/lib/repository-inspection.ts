import {
  GitHubClient,
  GitHubRepositoryError,
  parseGitHubRepositoryUrl,
  type GitHubClientOptions
} from "@/lib/github";
import { inspectPackageFiles, type RepositoryInspection } from "@/lib/package-inspection";

export type RepositoryInspectionOptions = GitHubClientOptions;

export async function inspectPublicNpmRepository(
  repositoryUrl: string,
  options: RepositoryInspectionOptions = {}
): Promise<RepositoryInspection> {
  const ref = parseGitHubRepositoryUrl(repositoryUrl);
  const client = new GitHubClient(options);
  const metadata = await client.getRepositoryMetadata(ref);
  const packageJsonText = await client.getRepositoryFileText(
    ref,
    "package.json",
    metadata.defaultBranch
  );

  if (packageJsonText === null) {
    throw new GitHubRepositoryError("This repository does not contain a root package.json.");
  }

  const packageLockText = await client.getRepositoryFileText(
    ref,
    "package-lock.json",
    metadata.defaultBranch
  );
  const pnpmLockText = await client.getRepositoryFileText(
    ref,
    "pnpm-lock.yaml",
    metadata.defaultBranch
  );
  const yarnLockText = await client.getRepositoryFileText(ref, "yarn.lock", metadata.defaultBranch);
  const bunLockText =
    (await client.getRepositoryFileText(ref, "bun.lock", metadata.defaultBranch)) ??
    (await client.getRepositoryFileText(ref, "bun.lockb", metadata.defaultBranch));

  return {
    metadata,
    package: inspectPackageFiles({
      packageJsonText,
      packageLockText,
      pnpmLockText,
      yarnLockText,
      bunLockText
    })
  };
}
