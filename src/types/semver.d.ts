declare module "semver" {
  export type ReleaseType =
    "major" | "premajor" | "minor" | "preminor" | "patch" | "prepatch" | "prerelease";

  const semver: {
    clean(version: string): string | null;
    compare(left: string, right: string): number;
    diff(left: string, right: string): ReleaseType | null;
    valid(version: string): string | null;
  };

  export default semver;
}
