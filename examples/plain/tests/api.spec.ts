import { test, expect } from "@traceoptix/playwright/test";

const siteinfo = {
  action: "query",
  meta: "siteinfo",
  siprop: "general",
  format: "json",
  formatversion: 2,
};

test(
  "Wikipedia API returns site information",
  { tag: ["@api", "@p1"] },
  async ({ request }) => {
    await test.step("Read Wikipedia site information", async () => {
      const response = await request.get("/w/api.php", { params: siteinfo });
      await test.step("Validate status and site name", async () => {
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.query.general.sitename).toBe("Wikipedia");
        expect(body.query.general.lang).toBe("en");
      });
    });
  },
);

test(
  "Wikipedia API deliberate status mismatch",
  { tag: ["@api", "@intentional-failure"] },
  async ({ request }) => {
    await test.step("Read the same working API", async () => {
      const response = await request.get("/w/api.php", { params: siteinfo });
      await test.step("Demonstrate failed API evidence", async () => {
        // Deliberately incorrect: Wikipedia returns 200, not 418.
        expect(
          response.status(),
          "Intentional demo failure: expect an incorrect HTTP status",
        ).toBe(418);
      });
    });
  },
);
