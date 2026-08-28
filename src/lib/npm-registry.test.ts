import { describe, expect, it, vi } from "vitest";

import { NpmRegistryClient } from "@/lib/npm-registry";

describe("NpmRegistryClient", () => {
  it("fetches latest package versions from the npm registry", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://registry.npmjs.org/%40acme%2Fwidgets") {
        return Response.json({ "dist-tags": { latest: "2.0.0" } });
      }

      return Response.json({ "dist-tags": { latest: "1.0.0" } });
    });
    const client = new NpmRegistryClient({ fetchImpl: fetchImpl as typeof fetch });

    await expect(client.getLatestVersion("@acme/widgets")).resolves.toEqual({
      status: "found",
      packageName: "@acme/widgets",
      latestVersion: "2.0.0"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40acme%2Fwidgets",
      expect.any(Object)
    );
  });

  it("deduplicates package lookups and returns partial failures", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/missing")) {
        return new Response("not found", { status: 404 });
      }

      return Response.json({ "dist-tags": { latest: "1.2.3" } });
    });
    const client = new NpmRegistryClient({
      fetchImpl: fetchImpl as typeof fetch,
      concurrency: 2
    });
    const results = await client.getLatestVersions(["react", "react", "missing"]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(results.get("react")).toEqual({
      status: "found",
      packageName: "react",
      latestVersion: "1.2.3"
    });
    expect(results.get("missing")).toMatchObject({
      status: "unavailable",
      packageName: "missing",
      reason: "npm registry returned 404."
    });
  });
});
