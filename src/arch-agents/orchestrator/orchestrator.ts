import { runAgent } from "../agent/agent-factory.js";
import { buildDependencyGraph } from "../graph/graph.js";
import { ManifestBus } from "../manifest/manifest-bus.js";
import type { AgentManifest, OrchestratorConfig } from "../types.js";

export class Orchestrator {
  constructor(private config: OrchestratorConfig) {}

  async run(task: string): Promise<AgentManifest[]> {
    const pipelineAgents = this.config.agents.filter((a) => !a.standalone);
    const graph = buildDependencyGraph(pipelineAgents);
    const bus = new ManifestBus();
    const allManifests: AgentManifest[] = [];

    for (let waveIndex = 0; waveIndex < graph.waves.length; waveIndex += 1) {
      const wave = graph.waves[waveIndex];

      this.config.onProgress?.({
        type: "wave_start",
        wave: waveIndex,
        agents: wave.map((a) => a.name),
      });

      const results = await Promise.allSettled(
        wave.map(async (def) => {
          const modelId = def.model ?? this.config.model ?? "default";
          this.config.onProgress?.({ type: "agent_start", agent: def.name, model: modelId });

          try {
            const context = bus.getContext(def.dependsOn ?? []);
            const manifest = await runAgent(def, task, context, this.config);
            bus.set(manifest);
            this.config.onProgress?.({ type: "agent_done", agent: def.name, manifest });
            return manifest;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.config.onProgress?.({ type: "agent_error", agent: def.name, error: err });
            throw err;
          }
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          allManifests.push(result.value);
        }
      }

      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) {
        const reason = rejected.reason instanceof Error
          ? rejected.reason
          : new Error(String(rejected.reason));
        throw new Error(`Wave ${waveIndex}: ${reason.message}`);
      }
    }

    this.config.onProgress?.({ type: "orchestrator_done", manifests: allManifests });
    return allManifests;
  }
}
