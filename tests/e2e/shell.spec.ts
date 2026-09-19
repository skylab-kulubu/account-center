import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("desktop account shell exposes every v1 area", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only assertion");
  const errors = failOnPageErrors(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Hesabın, tek ve güvenli bir merkezde." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Hesap ayarları" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "İçeriğe geç" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.getByRole("link", { name: "Giriş ve güvenlik" }).first().click();
  await expect(page.getByRole("heading", { name: "Giriş ve güvenlik" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile detail pages use a direct back affordance", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await page.goto("/sessions");

  await expect(page.getByRole("link", { name: "Hesap Merkezi özetine dön" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Oturumlar ve cihazlar" })).toBeVisible();
});

test("reduced motion removes ambient animation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "reduced-motion", "reduced-motion-only assertion");
  const errors = failOnPageErrors(page);
  await page.goto("/");

  const duration = await page.locator(".background__bloom").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).animationDuration),
  );
  expect(duration).toBeLessThanOrEqual(0.001);

  await page.evaluate(() => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("logo-loader__path");
    path.dataset.logoGroup = "1";
    document.body.append(path);
  });
  const loaderPath = page.locator(".logo-loader__path");
  const loaderStyle = await loaderPath.evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: Number.parseFloat(style.animationDuration), opacity: style.opacity };
  });
  expect(loaderStyle.duration).toBeLessThanOrEqual(0.001);
  expect(loaderStyle.opacity).toBe("1");
  expect(errors).toEqual([]);
});
