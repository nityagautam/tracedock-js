import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";
import { fileURLToPath } from "node:url";
import { exampleConfig } from "../config.js";

const testDir = defineBddConfig({
  features: "./features/*.feature",
  steps: ["./fixtures.ts", "./steps/*.ts"],
  outputDir: "./.features-gen",
});

export default defineConfig(
  exampleConfig(fileURLToPath(new URL(".", import.meta.url)), "wikipedia-bdd"),
  {
    testDir,
    projects: [
      { name: "api", testMatch: /api\.feature\.spec\.js$/ },
      {
        name: "chromium",
        testMatch: /ui\.feature\.spec\.js$/,
        use: { browserName: "chromium" },
      },
    ],
  },
);
