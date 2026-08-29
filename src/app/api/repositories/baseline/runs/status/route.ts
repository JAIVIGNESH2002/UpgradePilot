import { NextResponse } from "next/server";

import { getBaselineRun } from "@/lib/baseline-run-store";

export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("runId");

  if (!runId) {
    return NextResponse.json({ message: "Baseline run ID is required." }, { status: 400 });
  }

  const run = getBaselineRun(runId);

  if (!run) {
    return NextResponse.json({ message: "Baseline run was not found." }, { status: 404 });
  }

  return NextResponse.json({ run });
}
