import { runAgent } from "../agent/agent-factory.js";
import { buildDependencyGraph } from "../graph/graph.js";
import { ManifestBus } from "../manifest/manifest-bus.js";
import type { AgentDefinition, AgentManifest, OrchestratorConfig, ProgressEvent } from "../types.js";

export class Orchestrator {
  constructor(private config: OrchestratorConfig) {}

  async run(task: string, parentContext?: string): Promise<AgentManifest[]> {
    return this.runPipeline(this.config.agents, task, parentContext);
  }

  // ── Core pipeline runner (shared by top-level and composite agents) ──

  private async runPipeline(
    agents: AgentDefinition[],
    task: string,
    parentContext: string | undefined,
    namePrefix?: string,
  ): Promise<AgentManifest[]> {
    const pipelineAgents = agents.filter((a) => !a.standalone);
    const graph = buildDependencyGraph(pipelineAgents);
    const bus = new ManifestBus();
    const allManifests: AgentManifest[] = [];

    const qualify = (name: string) => namePrefix ? `${namePrefix}/${name}` : name;

    for (let waveIndex = 0; waveIndex < graph.waves.length; waveIndex += 1) {
      const wave = graph.waves[waveIndex];

      this.config.onProgress?.({
        type: "wave_start",
        wave: waveIndex,
        agents: wave.map((a) => qualify(a.name)),
      });

      const results = await Promise.allSettled(
        wave.map(async (def) => {
          const qualifiedName = qualify(def.name);
          const modelId = def.model ?? this.config.model;
          this.config.onProgress?.({ type: "agent_start", agent: qualifiedName, model: modelId });

          try {
            const deps = def.dependsOn ?? [];

            // Build context: sibling dependencies + parent upstream context
            let context: string;
            if (deps.length > 0) {
              this.config.onProgress?.({
                type: "agent_activity",
                agent: qualifiedName,
                message: `📨 Receiving context from ${deps.join(", ")}`,
              });
              const siblingContext = bus.getContext(deps, this.config.maxContextLength);
              context = parentContext
                ? `${siblingContext}\n\n## Parent upstream context\n${parentContext}`
                : siblingContext;
            } else {
              context = parentContext ?? "You run first — no upstream context.";
            }

            // Dispatch: composite (has subAgents) vs. leaf agent — with retry
            let manifest: AgentManifest;
            const maxRetries = this.config.maxRetries ?? 0;
            let lastError: Error | undefined;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                if (def.subAgents && def.subAgents.length > 0) {
                  manifest = await this.runCompositeAgent(def, task, context, qualifiedName);
                } else {
                  manifest = await this.runLeafAgent(def, task, context, namePrefix);
                }
                lastError = undefined;
                break;
              } catch (retryErr) {
                lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
                if (attempt < maxRetries) {
                  const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, …
                  this.config.onProgress?.({
                    type: "agent_retry",
                    agent: qualifiedName,
                    attempt: attempt + 1,
                    maxRetries,
                    error: lastError,
                  });
                  await new Promise((r) => setTimeout(r, delay));
                }
              }
            }

            if (lastError) {
              throw lastError;
            }
            manifest = manifest!;

            bus.set(manifest);
            this.config.onProgress?.({ type: "agent_done", agent: qualifiedName, manifest });
            return manifest;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.config.onProgress?.({ type: "agent_error", agent: qualifiedName, error: err });
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
        const label = namePrefix ? `${namePrefix} wave ${waveIndex}` : `Wave ${waveIndex}`;
        throw new Error(`${label}: ${reason.message}`);
      }
    }

    if (!namePrefix) {
      this.config.onProgress?.({ type: "orchestrator_done", manifests: allManifests });
    }

    return allManifests;
  }

  // ── Leaf agent: runs a single AI session ──

  private async runLeafAgent(
    def: AgentDefinition,
    task: string,
    context: string,
    namePrefix?: string,
  ): Promise<AgentManifest> {
    // Wrap onProgress to qualify agent names for sub-agents
    const config = namePrefix
      ? this.configWithQualifiedProgress(namePrefix)
      : this.config;

    return runAgent(def, task, context, config);
  }

  // ── Composite agent: runs sub-agents as a mini-pipeline ──

  private async runCompositeAgent(
    parentDef: AgentDefinition,
    task: string,
    parentContext: string,
    qualifiedParentName: string,
  ): Promise<AgentManifest> {
    // Sub-agents inherit model + thinkingLevel from parent where not specified
    const subAgents = parentDef.subAgents!.map((sub) => ({
      ...sub,
      model: sub.model ?? parentDef.model,
      thinkingLevel: sub.thinkingLevel ?? parentDef.thinkingLevel,
    }));

    const manifests = await this.runPipeline(
      subAgents,
      task,
      parentContext,
      qualifiedParentName,
    );

    // Merge all sub-agent manifests into one composite manifest
    return {
      agent: parentDef.name,
      changedFiles: [...new Set(manifests.flatMap((m) => m.changedFiles))],
      summary: manifests.map((m) => `[${m.agent}] ${m.summary}`).join("; "),
      exports: Object.assign({}, ...manifests.map((m) => m.exports)),
    };
  }

  // ── Helper: create config that qualifies agent names in progress events ──

  private configWithQualifiedProgress(prefix: string): OrchestratorConfig {
    if (!this.config.onProgress) return this.config;

    return {
      ...this.config,
      onProgress: (event: ProgressEvent) => {
        if ("agent" in event) {
          this.config.onProgress!({
            ...event,
            agent: `${prefix}/${(event as any).agent}`,
          } as ProgressEvent);
        } else {
          this.config.onProgress!(event);
        }
      },
    };
  }
}
