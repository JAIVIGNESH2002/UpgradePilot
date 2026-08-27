"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { runBaselineVerification } from "@/lib/baseline";
import { setBaselineRun } from "@/lib/baseline-store";
import { inspectPublicNpmRepository } from "@/lib/repository-inspection";
import { TrueForgeIntegrationError, TrueForgeSandboxProvider } from "@/lib/trueforge";

export async function inspectRepositoryAction(formData: FormData) {
  const repositoryUrl = readRepositoryUrl(formData);
  redirect(`/?repo=${encodeURIComponent(repositoryUrl)}`);
}

export async function runBaselineAction(formData: FormData) {
  const repositoryUrl = readRepositoryUrl(formData);

  try {
    const inspection = await inspectPublicNpmRepository(repositoryUrl, {
      token: process.env.GITHUB_TOKEN
    });
    const result = await runBaselineVerification({
      repositoryUrl,
      scripts: inspection.package.scripts,
      sandboxProvider: new TrueForgeSandboxProvider()
    });

    setBaselineRun(repositoryUrl, {
      status: "COMPLETED",
      result
    });
  } catch (error) {
    setBaselineRun(repositoryUrl, {
      status: "BLOCKED",
      message:
        error instanceof TrueForgeIntegrationError || error instanceof Error
          ? error.message
          : "Baseline verification could not be completed."
    });
  }

  revalidatePath("/");
  redirect(`/?repo=${encodeURIComponent(repositoryUrl)}`);
}

function readRepositoryUrl(formData: FormData): string {
  const repositoryUrl = formData.get("repositoryUrl");

  if (typeof repositoryUrl !== "string" || repositoryUrl.trim() === "") {
    throw new Error("Repository URL is required.");
  }

  return repositoryUrl.trim();
}
