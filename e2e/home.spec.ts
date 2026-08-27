import { expect, test } from "@playwright/test";

test("renders the repository inspection entry point", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "UpgradePilot" })).toBeVisible();
  await expect(page.getByLabel("Public GitHub npm repository URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Inspect repository" })).toBeEnabled();
});
