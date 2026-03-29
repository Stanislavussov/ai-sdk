import { runAgent } from "../agent/agent-factory.js";
import { buildDependencyGraph } from "../graph/graph.js";
import { ManifestBus } from "../manifest/manifest-bus.js";
import { log } from "../logger.js";
import type { AgentDefinition, AgentManifest, OrchestratorConfig, ProgressEvent } from "../types.js";

export class Orchestrator {
  constructor(private config: OrchestratorConfig) {}

  async run(task: string, parentContext?: string): Promise<AgentManifest[]> {
    log.info("ORCH", "═══ Orchestrator.run() ═══", {
      task: task.slice(0, 200),
      totalAgents: this.config.agents.length,
      agentNames: this.config.agents.map((a) => a.name),
      model: this.config.model,
      hasParentContext: !!parentContext,
    });
    return this.runPipeline(this.config.agents, task, parentContext);
  }

  // ── Core pipeline runner (shared by top-level and composite agents) ──

  private async runPipeline(
    agents: AgentDefinition[],
    task: string,
    parentContext: string | undefined,
    namePrefix?: string,
    /** All agents in this pipeline level — used for sibling boundary awareness */
    allSiblings?: AgentDefinition[],
  ): Promise<AgentManifest[]> {
    const pipelineAgents = agents.filter((a) => !a.standalone);
    const standaloneAgents = agents.filter((a) => a.standalone);
    const siblings = allSiblings ?? pipelineAgents;
    const graph = buildDependencyGraph(pipelineAgents);
    const bus = new ManifestBus();
    const allManifests: AgentManifest[] = [];

    const qualify = (name: string) => namePrefix ? `${namePrefix}/${name}` : name;
    const pipelineLabel = namePrefix ?? "top-level";

    log.info("ORCH", `Pipeline [${pipelineLabel}]: ${pipelineAgents.length} agents, ${graph.waves.length} waves`, {
      pipeline: pipelineAgents.map((a) => a.name),
      skippedStandalone: standaloneAgents.map((a) => a.name),
      waves: graph.waves.map((w, i) => `wave${i}: [${w.map((a) => a.name).join(", ")}]`),
    });

    for (let waveIndex = 0; waveIndex < graph.waves.length; waveIndex += 1) {
      const wave = graph.waves[waveIndex];

      log.info("ORCH", `── Wave ${waveIndex} starting ──`, {
        agents: wave.map((a) => qualify(a.name)),
        busState: bus.all().map((m) => m.agent),
      });

      this.config.onProgress?.({
        type: "wave_start",
        wave: waveIndex,
        agents: wave.map((a) => qualify(a.name)),
      });

      const results = await Promise.allSettled(
        wave.map(async (def) => {
          const qualifiedName = qualify(def.name);
          const modelId = def.model ?? this.config.model;

          log.info("ORCH", `▶ Agent "${qualifiedName}" starting`, {
            model: modelId,
            type: def.type ?? "coding",
            dependsOn: def.dependsOn ?? [],
            isComposite: !!(def.subAgents?.length),
          });

          this.config.onProgress?.({ type: "agent_start", agent: qualifiedName, model: modelId });

          try {
            const deps = def.dependsOn ?? [];

            // Build context: ALL accumulated manifests + parent upstream context.
            // dependsOn controls scheduling (wave order) only — every agent
            // sees the full knowledge bus so no upstream reasoning is lost.
            let context: string;
            const fullContext = bus.getFullContext();
            const hasUpstream = bus.all().length > 0;

            if (hasUpstream) {
              const upstreamNames = bus.all().map((m) => m.agent);
              log.debug("ORCH", `Agent "${qualifiedName}" receiving upstream context`, {
                fromAgents: upstreamNames,
                contextLength: fullContext.length,
                hasParentContext: !!parentContext,
              });
              this.config.onProgress?.({
                type: "agent_activity",
                agent: qualifiedName,
                message: `📨 Receiving context from ${upstreamNames.join(", ")}`,
              });
              context = parentContext
                ? `${fullContext}\n\n## Parent upstream context\n${parentContext}`
                : fullContext;
            } else {
              log.debug("ORCH", `Agent "${qualifiedName}" runs first — no upstream context`);
              context = parentContext ?? "You run first — no upstream context.";
            }

            // Dispatch: composite (has subAgents) vs. leaf agent
            let manifest: AgentManifest;
            if (def.subAgents && def.subAgents.length > 0) {
              log.info("ORCH", `Agent "${qualifiedName}" is composite — dispatching ${def.subAgents.length} sub-agents`);
              manifest = await this.runCompositeAgent(def, task, context, qualifiedName);
            } else {
              log.info("ORCH", `Agent "${qualifiedName}" is leaf — dispatching to runAgent`);
              manifest = await this.runLeafAgent(def, task, context, namePrefix, siblings);
            }

            log.info("ORCH", `✓ Agent "${qualifiedName}" done`, {
              summary: manifest.summary,
              changedFiles: manifest.changedFiles,
              exports: Object.keys(manifest.exports),
            });

            bus.set(manifest);
            this.config.onProgress?.({ type: "agent_done", agent: qualifiedName, manifest });

            // Log bus snapshot after every agent so consumers can verify
            // that all upstream context accumulates correctly.
            const snap = bus.snapshot();
            this.config.onProgress?.({
              type: "bus_snapshot",
              afterAgent: qualifiedName,
              manifests: snap.manifests,
              contextForNext: snap.contextForNext,
            });

            return manifest;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error("ORCH", `✗ Agent "${qualifiedName}" failed`, {
              error: err.message,
              stack: err.stack?.split("\n").slice(0, 5).join("\n"),
            });
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

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      log.info("ORCH", `── Wave ${waveIndex} complete ── ${fulfilled} ok, ${failed} failed`);

      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) {
        const reason = rejected.reason instanceof Error
          ? rejected.reason
          : new Error(String(rejected.reason));
        const label = namePrefix ? `${namePrefix} wave ${waveIndex}` : `Wave ${waveIndex}`;
        log.error("ORCH", `Pipeline [${pipelineLabel}] aborted at wave ${waveIndex}`, { error: reason.message });
        throw new Error(`${label}: ${reason.message}`);
      }
    }

    if (!namePrefix) {
      log.info("ORCH", `═══ Pipeline complete — ${allManifests.length} agents finished ═══`, {
        agents: allManifests.map((m) => m.agent),
        totalChangedFiles: [...new Set(allManifests.flatMap((m) => m.changedFiles))].length,
      });
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
    siblings?: AgentDefinition[],
  ): Promise<AgentManifest> {
    // Wrap onProgress to qualify agent names for sub-agents
    const config = namePrefix
      ? this.configWithQualifiedProgress(namePrefix)
      : this.config;

    return runAgent(def, task, context, config, siblings);
  }

  // ── Composite agent: runs sub-agents as a mini-pipeline ──

  private async runCompositeAgent(
    parentDef: AgentDefinition,
    task: string,
    parentContext: string,
    qualifiedParentName: string,
  ): Promise<AgentManifest> {
    log.info("ORCH", `Composite agent "${qualifiedParentName}" — running ${parentDef.subAgents!.length} sub-agents`, {
      subAgents: parentDef.subAgents!.map((s) => s.name),
    });

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
      subAgents,
    );

    const compositeManifest: AgentManifest = {
      agent: parentDef.name,
      changedFiles: [...new Set(manifests.flatMap((m) => m.changedFiles))],
      summary: manifests.map((m) => `[${m.agent}] ${m.summary}`).join("; "),
      exports: Object.assign({}, ...manifests.map((m) => m.exports)),
    };

    log.info("ORCH", `Composite agent "${qualifiedParentName}" merged manifest`, {
      changedFiles: compositeManifest.changedFiles,
      exports: Object.keys(compositeManifest.exports),
    });

    // Merge all sub-agent manifests into one composite manifest
    return compositeManifest;
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
