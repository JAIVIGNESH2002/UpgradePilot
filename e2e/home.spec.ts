import { expect, test } from "@playwright/test";

test("renders the repository workspace shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "UpgradePilot" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Public GitHub repository URL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add repository" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Add a repository to begin" })).toBeVisible();
});
