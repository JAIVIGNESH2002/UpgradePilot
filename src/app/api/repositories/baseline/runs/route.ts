import { NextResponse } from "next/server";

import { startBaselineRun } from "@/lib/baseline-run-store";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { repositoryUrl?: unknown };

    if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim() === "") {
      return NextResponse.json({ message: "Repository URL is required." }, { status: 400 });
    }

    const run = await startBaselineRun(body.repositoryUrl);

    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Baseline run failed to start." },
      { status: 400 }
    );
  }
}
