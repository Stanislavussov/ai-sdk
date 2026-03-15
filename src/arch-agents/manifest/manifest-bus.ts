import type { AgentManifest } from "../types.js";

export class ManifestBus {
  private store = new Map<string, AgentManifest>();

  set(manifest: AgentManifest): void {
    this.store.set(manifest.agent, manifest);
  }

  getContext(dependsOn: string[]): string {
    if (dependsOn.length === 0) {
      return "You run first — no upstream context.";
    }

    const blocks = dependsOn.map((dep) => {
      const manifest = this.store.get(dep);
      if (!manifest) {
        throw new Error(`Missing manifest for dependency agent: ${dep}`);
      }

      const changedFiles = manifest.changedFiles.length > 0
        ? manifest.changedFiles.join(", ")
        : "(none)";

      const exportLines = Object.entries(manifest.exports).length > 0
        ? Object.entries(manifest.exports)
            .map(([symbol, location]) => `  ${symbol} → ${location}`)
            .join("\n")
        : "  (none)";

      return [
        `## Output from [${dep}] agent`,
        manifest.summary,
        `Changed files: ${changedFiles}`,
        "Exports:",
        exportLines,
      ].join("\n");
    });

    return blocks.join("\n\n");
  }

  all(): AgentManifest[] {
    return Array.from(this.store.values());
  }
}
