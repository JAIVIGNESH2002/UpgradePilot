import { NextResponse } from "next/server";

import { getUpgradeRun } from "@/lib/upgrade-run-store";

export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("runId");

  if (!runId) {
    return NextResponse.json({ message: "Upgrade run ID is required." }, { status: 400 });
  }

  const run = getUpgradeRun(runId);

  if (!run) {
    return NextResponse.json({ message: "Upgrade run was not found." }, { status: 404 });
  }

  return NextResponse.json({ run });
}
