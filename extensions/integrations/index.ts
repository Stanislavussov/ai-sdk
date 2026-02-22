import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as yaml from "yaml";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { setupGithubIntegration } from "./github/index.js";

// Resolve paths relative to THIS file, not the working directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function (pi: ExtensionAPI) {
  // ── /terminal command — open a new terminal tab with a command ───
  pi.registerCommand("terminal", {
    description:
      "Open a new terminal tab and run a command (e.g. /terminal npx expo start)",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) {
        ctx.ui.notify(
          "Usage: /terminal <command>  (e.g. /terminal npx expo start)",
          "warning",
        );
        return;
      }

      const cwd = ctx.cwd;

      // Use osascript to open a new Terminal.app tab with the command
      const script = `
        tell application "Terminal"
          activate
          do script "cd ${cwd.replace(/"/g, '\\"')} && ${command.replace(/"/g, '\\"')}"
        end tell
      `;

      await pi.exec("osascript", ["-e", script], { cwd });

      ctx.ui.notify(`🖥️ Opened new terminal: ${command}`, "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    try {
      // config.yaml lives next to this index.ts file
      const configPath = path.join(__dirname, "config.yaml");
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
