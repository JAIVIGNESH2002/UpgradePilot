import { NextResponse } from "next/server";

import { enrichDependencyVersion } from "@/lib/dependency-versions";
import { NpmRegistryClient } from "@/lib/npm-registry";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { repositoryUrl?: unknown };

    if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim() === "") {
      return NextResponse.json({ message: "Repository URL is required." }, { status: 400 });
    }

    const inspection = await inspectPublicNpmRepository(body.repositoryUrl.trim(), {
      token: process.env.GITHUB_TOKEN
    });
    const registryClient = new NpmRegistryClient();
    const latestVersions = await registryClient.getLatestVersions(
      inspection.package.dependencies.map((dependency) => dependency.packageName)
    );
    const dependencyVersions = Object.fromEntries(
      inspection.package.dependencies.map((dependency) => [
        dependency.packageName,
        enrichDependencyVersion(dependency, latestVersions.get(dependency.packageName))
      ])
    );

    return NextResponse.json({ inspection, dependencyVersions });
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error ? error.message : "Repository inspection failed."
      },
      { status: 400 }
    );
  }
}
