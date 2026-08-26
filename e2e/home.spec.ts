import { expect, test } from "@playwright/test";

test("renders the project foundation page", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "UpgradePilot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Product UI coming later" })).toBeDisabled();
});
