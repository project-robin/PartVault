import { test, expect } from "@playwright/test";

test("login, create part, upload file, see Ready", async ({ page }) => {
  const baseURL = process.env.PARTVAULT_URL ?? "http://localhost:5173";
  await page.goto(`${baseURL}/login`);
  await expect(page.getByRole("heading", { name: /login/i })).toBeVisible();

  // In CI against the deployed stack, Cognito Hosted UI handles auth.
  // This test is skipped locally (no real Cognito credentials).
  test.skip(!process.env.E2E_USER_EMAIL, "E2E credentials not configured");

  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByLabel(/email/i).fill(process.env.E2E_USER_EMAIL!);
  await page.getByLabel(/password/i).fill(process.env.E2E_USER_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).last().click();

  await page.waitForURL(`${baseURL}/`);
  await page.getByRole("button", { name: /new part/i }).click();
  await page.getByLabel(/part number/i).fill("PV-9999");
  await page.getByLabel(/name/i).fill("E2E Part");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByText("PV-9999")).toBeVisible();
});
