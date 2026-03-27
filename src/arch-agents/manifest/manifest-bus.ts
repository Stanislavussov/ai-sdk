import type { AgentManifest } from "../types.js";

export class ManifestBus {
  private store = new Map<string, AgentManifest>();

  set(manifest: AgentManifest): void {
    this.store.set(manifest.agent, manifest);
  }

  getContext(dependsOn: string[], maxLength?: number): string {
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

    let result = blocks.join("\n\n");

    // Truncate if the combined context exceeds the limit
    if (maxLength && result.length > maxLength) {
      // Strategy: proportionally truncate each block's summary to fit
      const overhead = blocks.reduce((sum, block, i) => {
        const manifest = this.store.get(dependsOn[i])!;
        return sum + (block.length - manifest.summary.length);
      }, (blocks.length - 1) * 2); // account for "\n\n" separators

      const availableForSummaries = maxLength - overhead;
      const maxSummaryLen = Math.max(
        80,
        Math.floor(availableForSummaries / dependsOn.length),
      );

      const truncatedBlocks = dependsOn.map((dep) => {
        const manifest = this.store.get(dep)!;
        let summary = manifest.summary;
        if (summary.length > maxSummaryLen) {
          summary = summary.slice(0, maxSummaryLen - 3) + "...";
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
          summary,
          `Changed files: ${changedFiles}`,
          "Exports:",
          exportLines,
        ].join("\n");
      });

      result = truncatedBlocks.join("\n\n");
    }

    return result;
  }

  all(): AgentManifest[] {
    return Array.from(this.store.values());
  }
}
