import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges conditional classes and resolves Tailwind conflicts", () => {
    expect(cn("px-2", "px-4", false && "hidden", ["text-sm"])).toBe("px-4 text-sm");
  });
});
