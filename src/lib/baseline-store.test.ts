import { afterEach, describe, expect, it } from "vitest";

import { clearBaselineRunsForTests, getBaselineRun, setBaselineRun } from "@/lib/baseline-store";

describe("baseline-store", () => {
  afterEach(() => {
    clearBaselineRunsForTests();
  });

  it("returns NOT_RUN by default", () => {
    expect(getBaselineRun("https://github.com/acme/widgets")).toEqual({ status: "NOT_RUN" });
  });

  it("round-trips BLOCKED baseline states", () => {
    setBaselineRun("https://github.com/acme/blocked", {
      status: "BLOCKED",
      message: "Repository is unsupported."
    });

    expect(getBaselineRun("https://github.com/acme/blocked")).toEqual({
      status: "BLOCKED",
      message: "Repository is unsupported."
    });
  });

  it("round-trips COMPLETED baseline states", () => {
    setBaselineRun("https://github.com/acme/widgets", {
      status: "COMPLETED",
      result: {
        status: "PASSED",
        install: { command: "npm ci", exitCode: 0, durationMs: 10, output: "installed" },
        verification: [
          { command: "npm run test", exitCode: 0, durationMs: 20, output: "passed" }
        ],
        skippedScripts: []
      }
    });

    expect(getBaselineRun("https://github.com/acme/widgets")).toMatchObject({
      status: "COMPLETED",
      result: {
        status: "PASSED",
        install: { command: "npm ci" },
        verification: [{ command: "npm run test" }]
      }
    });
  });
});
