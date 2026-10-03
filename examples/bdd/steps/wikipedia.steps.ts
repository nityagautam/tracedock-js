import { Given, When, Then, expect } from "../fixtures.js";

Given("the English Wikipedia API is selected", async ({ baseURL }) => {
  expect(baseURL).toBe("https://en.wikipedia.org");
});

When(
  "I request the Wikipedia site information",
  async ({ request, apiState }) => {
    apiState.response = await request.get("/w/api.php", {
      params: {
        action: "query",
        meta: "siteinfo",
        siprop: "general",
        format: "json",
        formatversion: 2,
      },
    });
  },
);

Then("the API status should be {int}", async ({ apiState }, status: number) => {
  expect(apiState.response, "The request step must run first").toBeDefined();
  expect(apiState.response!.status()).toBe(status);
});

Then("the site name should be {string}", async ({ apiState }, name: string) => {
  const body = await apiState.response!.json();
  expect(body.query.general.sitename).toBe(name);
});

Given("I open the Wikipedia article", async ({ page }) => {
  await page.goto("/wiki/Wikipedia", { waitUntil: "domcontentloaded" });
});

Then(
  "the article heading should be {string}",
  async ({ page }, heading: string) => {
    await expect(page.locator("#firstHeading")).toHaveText(heading);
  },
);

Then("the article should describe a free encyclopedia", async ({ page }) => {
  await expect(page.locator("#mw-content-text")).toContainText(
    "free online encyclopedia",
  );
});
