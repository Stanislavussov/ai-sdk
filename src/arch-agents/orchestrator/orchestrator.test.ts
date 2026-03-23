import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDefinition, AgentManifest, OrchestratorConfig, ProgressEvent } from "../types.js";

// ── Hoisted mock ───────────────────────────────────────────

const { mockRunAgent } = vi.hoisted(() => {
  const mockRunAgent = vi.fn();
  return { mockRunAgent };
});

vi.mock("../agent/agent-factory.js", () => ({
  runAgent: mockRunAgent,
}));

// Import after mock setup
import { Orchestrator } from "./orchestrator.js";

// ── Helpers ────────────────────────────────────────────────

function agent(name: string, dependsOn?: string[]): AgentDefinition {
  return { name, role: `${name} role`, rules: `${name} rules`, dependsOn };
}

function manifest(agentName: string): AgentManifest {
  return {
    agent: agentName,
    changedFiles: [`${agentName}.ts`],
    summary: `${agentName} done`,
    exports: { [`${agentName}Export`]: `${agentName}.ts:1` },
  };
}

const TEST_MODEL = "anthropic/claude-sonnet-4-5";

describe("Orchestrator", () => {
  beforeEach(() => {
    mockRunAgent.mockReset();
  });

  // ── Basic execution ──────────────────────────────────────

  it("runs a single agent and returns its manifest", async () => {
    const m = manifest("a");
    mockRunAgent.mockResolvedValue(m);

    const orch = new Orchestrator({ agents: [agent("a")], model: TEST_MODEL });
    const result = await orch.run("Build stuff");

    expect(result).toEqual([m]);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "a" }),
      "Build stuff",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("runs independent agents concurrently in the same wave", async () => {
    const callOrder: string[] = [];
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
      callOrder.push(def.name);
      return manifest(def.name);
    });

    const orch = new Orchestrator({
      agents: [agent("a"), agent("b"), agent("c")],
      model: TEST_MODEL,
    });
    const result = await orch.run("Task");

    // All three should run (order may vary since they're concurrent)
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.agent).sort()).toEqual(["a", "b", "c"]);
  });

  it("runs dependent agents in sequence across waves", async () => {
    const callOrder: string[] = [];
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
      callOrder.push(def.name);
      return manifest(def.name);
    });

    const orch = new Orchestrator({
      agents: [agent("a"), agent("b", ["a"])],
      model: TEST_MODEL,
    });
    await orch.run("Task");

    // a must complete before b starts
    expect(callOrder.indexOf("a")).toBeLessThan(callOrder.indexOf("b"));
  });

  it("passes dependency context from ManifestBus to dependent agents", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
      return manifest(def.name);
    });

    const orch = new Orchestrator({
      agents: [agent("a"), agent("b", ["a"])],
      model: TEST_MODEL,
    });
    await orch.run("Task");

    // Second call (b) should receive context about a
    const secondCall = mockRunAgent.mock.calls[1];
    const contextArg = secondCall[2] as string;
    expect(contextArg).toContain("[a]");
    expect(contextArg).toContain("a done");
  });

  it("passes no-upstream context to root agents", async () => {
    mockRunAgent.mockResolvedValue(manifest("a"));

    const orch = new Orchestrator({ agents: [agent("a")], model: TEST_MODEL });
    await orch.run("Task");

    const contextArg = mockRunAgent.mock.calls[0][2] as string;
    expect(contextArg).toContain("no upstream context");
  });

  // ── Config forwarding ────────────────────────────────────

  it("passes config to runAgent", async () => {
    mockRunAgent.mockResolvedValue(manifest("a"));

    const config: OrchestratorConfig = {
      agents: [agent("a")],
      cwd: "/tmp/test",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
    };
    const orch = new Orchestrator(config);
    await orch.run("Task");

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.any(Object),
      "Task",
      expect.any(String),
      config,
    );
  });

  // ── Progress events ──────────────────────────────────────

  it("fires wave_start events", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a"), agent("b", ["a"])],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const waveStarts = events.filter((e) => e.type === "wave_start");
    expect(waveStarts).toHaveLength(2);
    expect(waveStarts[0]).toEqual({ type: "wave_start", wave: 0, agents: ["a"] });
    expect(waveStarts[1]).toEqual({ type: "wave_start", wave: 1, agents: ["b"] });
  });

  it("fires agent_start with root model when agent has no model override", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a")],
      model: "openai/gpt-5",
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const agentStarts = events.filter((e) => e.type === "agent_start");
    expect(agentStarts).toHaveLength(1);
    expect(agentStarts[0]).toEqual({
      type: "agent_start",
      agent: "a",
      model: "openai/gpt-5",
    });
  });

  it("fires agent_done events with manifest", async () => {
    const m = manifest("a");
    mockRunAgent.mockResolvedValue(m);

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const doneEvents = events.filter((e) => e.type === "agent_done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toEqual({
      type: "agent_done",
      agent: "a",
      manifest: m,
    });
  });

  it("fires orchestrator_done event with all manifests", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a"), agent("b")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const done = events.filter((e) => e.type === "orchestrator_done");
    expect(done).toHaveLength(1);
    expect((done[0] as any).manifests).toHaveLength(2);
  });

  it("uses agent-level model in agent_start when set", async () => {
    const agentDef = { ...agent("a"), model: "google/gemini-2.5-pro" as const };
    mockRunAgent.mockResolvedValue(manifest("a"));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agentDef],
      model: "openai/gpt-5",
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const start = events.find((e) => e.type === "agent_start") as any;
    expect(start.model).toBe("google/gemini-2.5-pro");
  });

  // ── Error handling ───────────────────────────────────────

  it("throws when an agent fails", async () => {
    mockRunAgent.mockRejectedValue(new Error("Agent exploded"));

    const orch = new Orchestrator({ agents: [agent("a")], model: TEST_MODEL });
    await expect(orch.run("Task")).rejects.toThrow("Wave 0: Agent exploded");
  });

  it("fires agent_error event before throwing", async () => {
    const err = new Error("Boom");
    mockRunAgent.mockRejectedValue(err);

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });

    await expect(orch.run("Task")).rejects.toThrow();

    const errorEvents = events.filter((e) => e.type === "agent_error");
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as any).agent).toBe("a");
    expect((errorEvents[0] as any).error).toBe(err);
  });

  it("wraps non-Error throws", async () => {
    mockRunAgent.mockRejectedValue("string error");

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });

    await expect(orch.run("Task")).rejects.toThrow("Wave 0: string error");
  });

  it("stops processing waves after a failure", async () => {
    mockRunAgent
      .mockRejectedValueOnce(new Error("Failed"))
      .mockResolvedValueOnce(manifest("b"));

    const orch = new Orchestrator({
      agents: [agent("a"), agent("b", ["a"])],
      model: TEST_MODEL,
    });

    await expect(orch.run("Task")).rejects.toThrow();
    // b should never run since a failed
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("collects fulfilled manifests even when one in wave fails", async () => {
    // In a wave with multiple agents, if one fails, the fulfilled ones
    // are still collected but the wave error is thrown.
    let callCount = 0;
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
      callCount++;
      if (def.name === "b") throw new Error("b failed");
      return manifest(def.name);
    });

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a"), agent("b")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });

    await expect(orch.run("Task")).rejects.toThrow(/Wave 0/);
    // Both should have been called since they're in the same wave
    expect(callCount).toBe(2);
  });

  // ── Standalone agents ─────────────────────────────────────

  it("excludes standalone agents from the pipeline", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const orch = new Orchestrator({
      agents: [
        agent("a"),
        { ...agent("b"), standalone: true },
        agent("c", ["a"]),
      ],
      model: TEST_MODEL,
    });
    const result = await orch.run("Task");

    expect(result.map((m) => m.agent).sort()).toEqual(["a", "c"]);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    const calledNames = mockRunAgent.mock.calls.map((c: any[]) => c[0].name);
    expect(calledNames).not.toContain("b");
  });

  it("runs all agents when none are standalone", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const orch = new Orchestrator({
      agents: [agent("a"), agent("b")],
      model: TEST_MODEL,
    });
    const result = await orch.run("Task");

    expect(result).toHaveLength(2);
  });

  it("returns empty manifests when all agents are standalone", async () => {
    const orch = new Orchestrator({
      agents: [
        { ...agent("a"), standalone: true },
        { ...agent("b"), standalone: true },
      ],
      model: TEST_MODEL,
    });
    const result = await orch.run("Task");

    expect(result).toEqual([]);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("fires orchestrator_done with only pipeline manifests", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [
        agent("a"),
        { ...agent("standalone-helper"), standalone: true },
      ],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const done = events.find((e) => e.type === "orchestrator_done") as any;
    expect(done.manifests).toHaveLength(1);
    expect(done.manifests[0].agent).toBe("a");
  });

  // ── Context passing activity ──────────────────────────────

  it("emits agent_activity when receiving context from dependencies", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("api"), agent("db", ["api"])],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const activity = events.filter((e) => e.type === "agent_activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toEqual({
      type: "agent_activity",
      agent: "db",
      message: "📨 Receiving context from api",
    });
  });

  it("lists multiple dependencies in the context activity message", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("api"), agent("auth"), agent("db", ["api", "auth"])],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const activity = events.filter((e) => e.type === "agent_activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toEqual({
      type: "agent_activity",
      agent: "db",
      message: "📨 Receiving context from api, auth",
    });
  });

  it("does not emit context activity for root agents (no dependencies)", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    const events: ProgressEvent[] = [];
    const orch = new Orchestrator({
      agents: [agent("a"), agent("b")],
      model: TEST_MODEL,
      onProgress: (e) => events.push(e),
    });
    await orch.run("Task");

    const activity = events.filter((e) => e.type === "agent_activity");
    expect(activity).toHaveLength(0);
  });

  it("does not emit context activity when onProgress is absent", async () => {
    mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

    // Should not throw — just silently skip
    const orch = new Orchestrator({
      agents: [agent("a"), agent("b", ["a"])],
      model: TEST_MODEL,
    });
    await expect(orch.run("Task")).resolves.toBeDefined();
  });

  // ── Graph errors bubble up ───────────────────────────────

  it("throws on cyclic dependencies", async () => {
    const orch = new Orchestrator({
      agents: [agent("a", ["b"]), agent("b", ["a"])],
      model: TEST_MODEL,
    });
    await expect(orch.run("Task")).rejects.toThrow(/Cycle detected/);
  });

  it("throws on unknown dependency", async () => {
    const orch = new Orchestrator({
      agents: [agent("a", ["nonexistent"])],
      model: TEST_MODEL,
    });
    await expect(orch.run("Task")).rejects.toThrow(/Unknown dependency/);
  });

  // ── Sub-agents (composite agents / agent trees) ──────────

  describe("sub-agents (composite agents)", () => {
    it("runs sub-agents and returns merged manifest", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("child-a"), agent("child-b")],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      // The parent becomes a composite — its manifest merges children
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("parent");
      expect(result[0].changedFiles).toContain("child-a.ts");
      expect(result[0].changedFiles).toContain("child-b.ts");
      expect(result[0].summary).toContain("[child-a]");
      expect(result[0].summary).toContain("[child-b]");
      expect(result[0].exports).toHaveProperty("child-aExport");
      expect(result[0].exports).toHaveProperty("child-bExport");
    });

    it("does not run the parent as a leaf agent", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("child")],
          },
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // Only child should run — parent is composite, not a leaf
      const calledNames = mockRunAgent.mock.calls.map((c: any[]) => c[0].name);
      expect(calledNames).toEqual(["child"]);
      expect(calledNames).not.toContain("parent");
    });

    it("respects dependsOn among sub-agents", async () => {
      const callOrder: string[] = [];
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        callOrder.push(def.name);
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [
              agent("child-a"),
              agent("child-b", ["child-a"]),
            ],
          },
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      expect(callOrder.indexOf("child-a")).toBeLessThan(callOrder.indexOf("child-b"));
    });

    it("passes parent upstream context to root sub-agents", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          agent("upstream"),
          {
            ...agent("parent", ["upstream"]),
            subAgents: [agent("child")],
          },
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // child should receive upstream's manifest context (forwarded through parent)
      const childCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child");
      const contextArg = childCall![2] as string;
      expect(contextArg).toContain("[upstream]");
      expect(contextArg).toContain("upstream done");
    });

    it("passes sibling context + parent context to dependent sub-agents", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          agent("upstream"),
          {
            ...agent("parent", ["upstream"]),
            subAgents: [
              agent("child-a"),
              agent("child-b", ["child-a"]),
            ],
          },
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // child-b should receive child-a's context (sibling) + upstream context (parent)
      const childBCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child-b");
      const contextArg = childBCall![2] as string;
      expect(contextArg).toContain("[child-a]");
      expect(contextArg).toContain("child-a done");
      expect(contextArg).toContain("Parent upstream context");
    });

    it("sub-agents inherit model from parent", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const parentDef: AgentDefinition = {
        ...agent("parent"),
        model: "google/gemini-2.5-pro",
        subAgents: [agent("child")],
      };

      const orch = new Orchestrator({
        agents: [parentDef],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // The config passed to runAgent should reflect the inherited model
      const childCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child");
      expect(childCall![0].model).toBe("google/gemini-2.5-pro");
    });

    it("sub-agent model overrides parent model", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const parentDef: AgentDefinition = {
        ...agent("parent"),
        model: "google/gemini-2.5-pro",
        subAgents: [{ ...agent("child"), model: "openai/gpt-5" }],
      };

      const orch = new Orchestrator({
        agents: [parentDef],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      const childCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child");
      expect(childCall![0].model).toBe("openai/gpt-5");
    });

    it("sub-agents inherit thinkingLevel from parent", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const parentDef: AgentDefinition = {
        ...agent("parent"),
        thinkingLevel: "high",
        subAgents: [agent("child")],
      };

      const orch = new Orchestrator({
        agents: [parentDef],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      const childCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child");
      expect(childCall![0].thinkingLevel).toBe("high");
    });

    it("fires progress events with qualified names (parent/child)", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [
          {
            ...agent("backend"),
            subAgents: [agent("db"), agent("api", ["db"])],
          },
        ],
        model: TEST_MODEL,
        onProgress: (e) => events.push(e),
      });
      await orch.run("Task");

      // wave_start events should use qualified names
      const subWaveStarts = events.filter(
        (e): e is Extract<ProgressEvent, { type: "wave_start" }> =>
          e.type === "wave_start" && e.agents.some((a) => a.startsWith("backend/")),
      );
      expect(subWaveStarts.length).toBeGreaterThanOrEqual(1);
      expect(subWaveStarts[0].agents).toContain("backend/db");

      // agent_start events should use qualified names
      const agentStarts = events
        .filter((e) => e.type === "agent_start")
        .map((e) => (e as any).agent);
      expect(agentStarts).toContain("backend/db");
      expect(agentStarts).toContain("backend/api");

      // agent_done events should use qualified names
      const agentDones = events
        .filter((e) => e.type === "agent_done")
        .map((e) => (e as any).agent);
      expect(agentDones).toContain("backend/db");
      expect(agentDones).toContain("backend/api");
    });

    it("deduplicates changedFiles in merged manifest", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => ({
        agent: def.name,
        changedFiles: ["shared.ts", `${def.name}.ts`],
        summary: `${def.name} done`,
        exports: {},
      }));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("a"), agent("b")],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      // shared.ts appears in both children — should be deduplicated
      const sharedCount = result[0].changedFiles.filter((f) => f === "shared.ts").length;
      expect(sharedCount).toBe(1);
    });

    it("merges exports from all sub-agents", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => ({
        agent: def.name,
        changedFiles: [],
        summary: `${def.name} done`,
        exports: { [`${def.name}Fn`]: `${def.name}.ts:1` },
      }));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("x"), agent("y")],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      expect(result[0].exports).toEqual({
        xFn: "x.ts:1",
        yFn: "y.ts:1",
      });
    });

    it("excludes standalone sub-agents from the pipeline", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [
              agent("child"),
              { ...agent("helper"), standalone: true },
            ],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      const calledNames = mockRunAgent.mock.calls.map((c: any[]) => c[0].name);
      expect(calledNames).toContain("child");
      expect(calledNames).not.toContain("helper");
    });

    it("handles composite agent mixed with leaf agents", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          agent("standalone-leaf"),
          {
            ...agent("composite", ["standalone-leaf"]),
            subAgents: [agent("sub-a"), agent("sub-b")],
          },
          agent("downstream", ["composite"]),
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      expect(result).toHaveLength(3);
      expect(result[0].agent).toBe("standalone-leaf");
      expect(result[1].agent).toBe("composite"); // merged sub-agent manifests
      expect(result[2].agent).toBe("downstream");
    });

    it("downstream agents see merged composite manifest", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("composite"),
            subAgents: [agent("sub-a"), agent("sub-b")],
          },
          agent("downstream", ["composite"]),
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // downstream should receive merged context from composite
      const downstreamCall = mockRunAgent.mock.calls.find(
        (c: any[]) => c[0].name === "downstream",
      );
      const ctx = downstreamCall![2] as string;
      expect(ctx).toContain("[composite]");
      expect(ctx).toContain("[sub-a]");
      expect(ctx).toContain("[sub-b]");
    });

    it("throws when a sub-agent fails", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "bad-child") throw new Error("Child exploded");
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("good-child"), agent("bad-child")],
          },
        ],
        model: TEST_MODEL,
      });

      await expect(orch.run("Task")).rejects.toThrow(/parent wave 0.*Child exploded/);
    });

    it("fires agent_error with qualified name when sub-agent fails", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "bad") throw new Error("Boom");
        return manifest(def.name);
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("bad")],
          },
        ],
        model: TEST_MODEL,
        onProgress: (e) => events.push(e),
      });

      await expect(orch.run("Task")).rejects.toThrow();

      const errors = events.filter((e) => e.type === "agent_error");
      expect(errors).toHaveLength(2); // one for parent/bad, one for parent
      expect((errors[0] as any).agent).toBe("parent/bad");
    });

    it("handles deeply nested sub-agents (3 levels)", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("root"),
            subAgents: [
              {
                ...agent("mid"),
                subAgents: [agent("leaf")],
              },
            ],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      // Only leaf should be called via runAgent
      const calledNames = mockRunAgent.mock.calls.map((c: any[]) => c[0].name);
      expect(calledNames).toEqual(["leaf"]);

      // root manifest should contain leaf's data
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("root");
      expect(result[0].changedFiles).toContain("leaf.ts");
    });

    it("fires qualified progress for deeply nested agents", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [
          {
            ...agent("L1"),
            subAgents: [
              {
                ...agent("L2"),
                subAgents: [agent("L3")],
              },
            ],
          },
        ],
        model: TEST_MODEL,
        onProgress: (e) => events.push(e),
      });
      await orch.run("Task");

      const agentStarts = events
        .filter((e) => e.type === "agent_start")
        .map((e) => (e as any).agent);
      expect(agentStarts).toContain("L1/L2");
      expect(agentStarts).toContain("L1/L2/L3");
    });

    it("returns empty manifest when composite has no non-standalone sub-agents", async () => {
      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [{ ...agent("only-child"), standalone: true }],
          },
        ],
        model: TEST_MODEL,
      });
      const result = await orch.run("Task");

      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("parent");
      expect(result[0].changedFiles).toEqual([]);
      expect(result[0].summary).toBe("");
      expect(result[0].exports).toEqual({});
    });

    it("empty subAgents array runs as leaf agent", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [{ ...agent("leaf"), subAgents: [] }],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      // Should run as a normal leaf agent
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(mockRunAgent.mock.calls[0][0].name).toBe("leaf");
    });

    it("root sub-agents with no deps get 'no upstream' when parent has no upstream", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("child")],
          },
        ],
        model: TEST_MODEL,
      });
      await orch.run("Task");

      const childCall = mockRunAgent.mock.calls.find((c: any[]) => c[0].name === "child");
      const contextArg = childCall![2] as string;
      expect(contextArg).toContain("no upstream context");
    });

    it("does not fire orchestrator_done from sub-pipeline", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [
          {
            ...agent("parent"),
            subAgents: [agent("child")],
          },
        ],
        model: TEST_MODEL,
        onProgress: (e) => events.push(e),
      });
      await orch.run("Task");

      // Only one orchestrator_done at the top level
      const doneEvents = events.filter((e) => e.type === "orchestrator_done");
      expect(doneEvents).toHaveLength(1);
    });

    it("parentContext is forwarded via run(task, parentContext)", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => manifest(def.name));

      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
      });
      await orch.run("Task", "External context provided");

      const contextArg = mockRunAgent.mock.calls[0][2] as string;
      expect(contextArg).toBe("External context provided");
    });
  });
});
