import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { exampleConfig } from "../config.js";

export default defineConfig(
  exampleConfig(
    fileURLToPath(new URL(".", import.meta.url)),
    "wikipedia-plain",
  ),
  {
    testDir: "./tests",
    projects: [
      { name: "api", testMatch: /api\.spec\.ts$/ },
      {
        name: "chromium",
        testMatch: /ui\.spec\.ts$/,
        use: { browserName: "chromium" },
      },
    ],
  },
);
