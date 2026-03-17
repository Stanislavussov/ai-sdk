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
});
