import { test, expect } from "@traceoptix/playwright/test";

test(
  "Wikipedia article is readable",
  { tag: ["@ui", "@p1"] },
  async ({ page }) => {
    await test.step("Open the Wikipedia article", async () => {
      await page.goto("/wiki/Wikipedia", { waitUntil: "domcontentloaded" });
    });
    await test.step("Check the article heading and content", async () => {
      await expect(page.locator("#firstHeading")).toHaveText("Wikipedia");
      await expect(page.locator("#mw-content-text")).toContainText(
        "free online encyclopedia",
      );
    });
  },
);

test(
  "Wikipedia UI deliberate heading mismatch",
  { tag: ["@ui", "@intentional-failure"] },
  async ({ page }) => {
    await test.step("Open the Wikipedia article", async () => {
      await page.goto("/wiki/Wikipedia", { waitUntil: "domcontentloaded" });
    });
    await test.step("Demonstrate screenshot, video and trace evidence", async () => {
      await expect(
        page.locator("#firstHeading"),
        "Intentional demo failure: expect an incorrect heading",
      ).toHaveText("TraceOptix intentionally incorrect heading");
    });
  },
);
