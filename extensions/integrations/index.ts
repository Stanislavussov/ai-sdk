import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as yaml from "yaml";
import * as fs from "fs/promises";
import * as path from "path";
import { setupGithubIntegration } from "./github/index.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    try {
      // Configuration is located in the same directory as this index.ts file
      const configPath = path.join(
        ctx.cwd,
        "extensions",
        "integrations",
        "config.yaml",
      );
      const fileContent = await fs.readFile(configPath, { encoding: "utf-8" });
      const config = yaml.parse(fileContent);

      // We specifically look for the `github` entry under `integrations` list
      if (
        Array.isArray(config?.integrations) &&
        config.integrations.includes("github")
      ) {
        setupGithubIntegration(pi, ctx);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        ctx.ui?.notify(
          `Error loading integrations config: ${e.message}`,
          "error",
        );
      }
    }
  });
}
