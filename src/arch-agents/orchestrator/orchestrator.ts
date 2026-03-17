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

    const startTime = Date.now();

    for (let waveIndex = 0; waveIndex < graph.waves.length; waveIndex += 1) {
      const wave = graph.waves[waveIndex];

<<<<<<< HEAD
      this.config.onProgress?.({
        type: "wave_start",
        wave: waveIndex,
        agents: wave.map((a) => a.name),
=======
      // Filter out agents that should be skipped
      const runnableAgents = wave.filter((a) => !skippedAgents.has(a.name));

      if (runnableAgents.length === 0) {
        // Entire wave is skipped
        continue;
      }

      const waveNumber = waveIndex + 1;
      const waveName = `Wave ${waveNumber}`;

      this.config.onProgress?.({
        type: "wave_start",
        wave: waveNumber,
        name: waveName,
        agents: runnableAgents.map((a) => a.name),
>>>>>>> 32c01bf (feat: update orchestrator progress events to include wave names and total execution time)
      });

      const results = await Promise.allSettled(
        wave.map(async (def) => {
          const modelId = def.model ?? this.config.model;
          this.config.onProgress?.({ type: "agent_start", agent: def.name, model: modelId });

          try {
            const deps = def.dependsOn ?? [];
            if (deps.length > 0) {
              this.config.onProgress?.({
                type: "agent_activity",
                agent: def.name,
                message: `📨 Receiving context from ${deps.join(", ")}`,
              });
            }
            const context = bus.getContext(deps);
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

<<<<<<< HEAD
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
=======
      // Record failures
      for (const failure of waveFailures) {
        allFailures.push(failure);
      }

      // In fail-fast mode, throw on first failure
      if (failureMode === "fail-fast" && waveFailures.length > 0) {
        const first = waveFailures[0];
        throw new Error(`Wave ${waveNumber}: ${first.error.message}`);
      }
    }

    const totalTimeMs = Date.now() - startTime;

    const result: OrchestratorResult = {
      manifests: allManifests,
      failures: allFailures,
      skipped: allSkipped,
      success: allFailures.length === 0 && allSkipped.length === 0,
    };

    this.config.onProgress?.({ type: "orchestrator_done", result, totalTimeMs });

    return result;
  }

  private async runAgentWithRetry(
    def: AgentDefinition,
    task: string,
    bus: ManifestBus,
    retryConfig: Required<RetryConfig>,
  ): Promise<AgentManifest> {
    const modelId = def.model ?? this.config.model;
    this.config.onProgress?.({ type: "agent_start", agent: def.name, model: modelId });

    const deps = def.dependsOn ?? [];
    if (deps.length > 0) {
      this.config.onProgress?.({
        type: "agent_activity",
        agent: def.name,
        message: `📨 Receiving context from ${deps.join(", ")}`,
      });
    }

    let lastError: Error | undefined;
    let delay = retryConfig.initialDelayMs;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts + 1; attempt++) {
      try {
        const context = bus.getContext(deps);
        const manifest = await runAgent(def, task, context, this.config);
        bus.set(manifest);
        this.config.onProgress?.({ type: "agent_done", agent: def.name, manifest });
        return manifest;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.config.onProgress?.({ type: "agent_error", agent: def.name, error: lastError });

        // Check if we have retries left
        if (attempt <= retryConfig.maxAttempts) {
          this.config.onProgress?.({
            type: "agent_retry",
            agent: def.name,
            attempt,
            maxAttempts: retryConfig.maxAttempts,
            delayMs: delay,
            error: lastError,
          });

          this.config.onProgress?.({
            type: "agent_activity",
            agent: def.name,
            message: `🔄 Retry ${attempt}/${retryConfig.maxAttempts} in ${Math.round(delay / 1000)}s...`,
          });

          await sleep(delay);
          delay = Math.min(delay * retryConfig.backoffMultiplier, retryConfig.maxDelayMs);
        }
      }
    }

    // Attach attempt count to error for tracking
    const finalError = lastError ?? new Error("Unknown error");
    (finalError as any)._attempts = retryConfig.maxAttempts + 1;
    throw finalError;
>>>>>>> 32c01bf (feat: update orchestrator progress events to include wave names and total execution time)
  }
}
