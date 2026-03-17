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
    expect(waveStarts[0]).toEqual({ type: "wave_start", wave: 1, name: "Wave 1", agents: ["a"] });
    expect(waveStarts[1]).toEqual({ type: "wave_start", wave: 2, name: "Wave 2", agents: ["b"] });
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
    await expect(orch.run("Task")).rejects.toThrow("Wave 1: Agent exploded");
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

    await expect(orch.run("Task")).rejects.toThrow("Wave 1: string error");
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

    await expect(orch.run("Task")).rejects.toThrow(/Wave 1/);
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
<<<<<<< HEAD
=======

  // ── Retry logic ──────────────────────────────────────────

  describe("retry", () => {
    it("retries failed agent up to maxAttempts", async () => {
      let attempts = 0;
      mockRunAgent.mockImplementation(async () => {
        attempts++;
        if (attempts < 3) throw new Error(`Attempt ${attempts} failed`);
        return manifest("a");
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: 1 },
        onProgress: (e) => events.push(e),
      });

      const result = await orch.run("Task");

      expect(result.success).toBe(true);
      expect(result.manifests).toHaveLength(1);
      expect(attempts).toBe(3); // 1 initial + 2 retries

      const retryEvents = events.filter((e) => e.type === "agent_retry");
      expect(retryEvents).toHaveLength(2);
    });

    it("emits agent_retry events with attempt info", async () => {
      mockRunAgent
        .mockRejectedValueOnce(new Error("Fail 1"))
        .mockResolvedValueOnce(manifest("a"));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 2, initialDelayMs: 10, backoffMultiplier: 2 },
        onProgress: (e) => events.push(e),
      });

      await orch.run("Task");

      const retry = events.find((e) => e.type === "agent_retry") as any;
      expect(retry).toBeDefined();
      expect(retry.agent).toBe("a");
      expect(retry.attempt).toBe(1);
      expect(retry.maxAttempts).toBe(2);
      expect(retry.delayMs).toBe(10);
    });

    it("emits activity message for retries", async () => {
      mockRunAgent
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValueOnce(manifest("a"));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 1, initialDelayMs: 2000 },
        onProgress: (e) => events.push(e),
      });

      await orch.run("Task");

      const activity = events.filter(
        (e) => e.type === "agent_activity" && (e as any).message.includes("Retry"),
      );
      expect(activity).toHaveLength(1);
      expect((activity[0] as any).message).toContain("🔄 Retry 1/1 in 2s");
    });

    it("uses exponential backoff between retries", async () => {
      const delays: number[] = [];
      mockRunAgent
        .mockRejectedValueOnce(new Error("Fail 1"))
        .mockRejectedValueOnce(new Error("Fail 2"))
        .mockResolvedValueOnce(manifest("a"));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 2, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 10000 },
        onProgress: (e) => {
          events.push(e);
          if (e.type === "agent_retry") delays.push(e.delayMs);
        },
      });

      await orch.run("Task");

      expect(delays).toEqual([100, 200]); // 100 * 2 = 200
    });

    it("caps delay at maxDelayMs", async () => {
      mockRunAgent
        .mockRejectedValueOnce(new Error("Fail 1"))
        .mockRejectedValueOnce(new Error("Fail 2"))
        .mockResolvedValueOnce(manifest("a"));

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 2, initialDelayMs: 100, backoffMultiplier: 10, maxDelayMs: 150 },
        onProgress: (e) => events.push(e),
      });

      await orch.run("Task");

      const retryEvents = events.filter((e) => e.type === "agent_retry") as any[];
      expect(retryEvents[0].delayMs).toBe(100);
      expect(retryEvents[1].delayMs).toBe(150); // capped at maxDelayMs
    });

    it("throws after exhausting all retries in fail-fast mode", async () => {
      mockRunAgent.mockRejectedValue(new Error("Always fails"));

      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        retry: { maxAttempts: 2, initialDelayMs: 1 },
      });

      await expect(orch.run("Task")).rejects.toThrow("Always fails");
      expect(mockRunAgent).toHaveBeenCalledTimes(3); // 1 + 2 retries
    });
  });

  // ── Continue mode ────────────────────────────────────────

  describe("continue mode", () => {
    it("continues with independent agents after failure", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [agent("a"), agent("b")],
        model: TEST_MODEL,
        failureMode: "continue",
      });

      const result = await orch.run("Task");

      expect(result.success).toBe(false);
      expect(result.manifests).toHaveLength(1);
      expect(result.manifests[0].agent).toBe("b");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].agent).toBe("a");
    });

    it("skips dependent agents when dependency fails", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a"), agent("b", ["a"])],
        model: TEST_MODEL,
        failureMode: "continue",
        onProgress: (e) => events.push(e),
      });

      const result = await orch.run("Task");

      expect(result.manifests).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].agent).toBe("a");
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].agent).toBe("b");
      expect(result.skipped[0].failedDependency).toBe("a");
    });

    it("emits agent_skipped events", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a"), agent("b", ["a"]), agent("c", ["b"])],
        model: TEST_MODEL,
        failureMode: "continue",
        onProgress: (e) => events.push(e),
      });

      await orch.run("Task");

      const skipped = events.filter((e) => e.type === "agent_skipped");
      expect(skipped).toHaveLength(2);
      expect(skipped.map((e: any) => e.agent).sort()).toEqual(["b", "c"]);
    });

    it("skips transitive dependents (grandchildren)", async () => {
      // a fails → b (depends on a) skipped → c (depends on b) skipped
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [
          agent("a"),
          agent("b", ["a"]),
          agent("c", ["b"]),
          agent("d"), // independent, should run
        ],
        model: TEST_MODEL,
        failureMode: "continue",
      });

      const result = await orch.run("Task");

      expect(result.manifests.map((m) => m.agent)).toEqual(["d"]);
      expect(result.skipped.map((s) => s.agent).sort()).toEqual(["b", "c"]);
    });

    it("continues with parallel independent branches", async () => {
      // a fails, but d (independent) and e (depends on d) should complete
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [
          agent("a"),
          agent("b", ["a"]),
          agent("c", ["b"]),
          agent("d"),
          agent("e", ["d"]),
        ],
        model: TEST_MODEL,
        failureMode: "continue",
      });

      const result = await orch.run("Task");

      expect(result.manifests.map((m) => m.agent).sort()).toEqual(["d", "e"]);
      expect(result.failures.map((f) => f.agent)).toEqual(["a"]);
      expect(result.skipped.map((s) => s.agent).sort()).toEqual(["b", "c"]);
    });

    it("includes attempt count in failures after retries", async () => {
      mockRunAgent.mockRejectedValue(new Error("Always fails"));

      const orch = new Orchestrator({
        agents: [agent("a")],
        model: TEST_MODEL,
        failureMode: "continue",
        retry: { maxAttempts: 2, initialDelayMs: 1 },
      });

      const result = await orch.run("Task");

      expect(result.failures[0].attempts).toBe(3); // 1 + 2 retries
    });

    it("orchestrator_done includes full result with failures and skipped", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("a failed");
        return manifest(def.name);
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [agent("a"), agent("b", ["a"]), agent("c")],
        model: TEST_MODEL,
        failureMode: "continue",
        onProgress: (e) => events.push(e),
      });

      await orch.run("Task");

      const done = events.find((e) => e.type === "orchestrator_done") as any;
      expect(done.result.success).toBe(false);
      expect(done.result.manifests).toHaveLength(1);
      expect(done.result.failures).toHaveLength(1);
      expect(done.result.skipped).toHaveLength(1);
    });

    it("skips entire wave if all agents have failed dependencies", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a" || def.name === "b") throw new Error(`${def.name} failed`);
        return manifest(def.name);
      });

      const events: ProgressEvent[] = [];
      const orch = new Orchestrator({
        agents: [
          agent("a"),
          agent("b"),
          agent("c", ["a"]),
          agent("d", ["b"]),
        ],
        model: TEST_MODEL,
        failureMode: "continue",
        onProgress: (e) => events.push(e),
      });

      const result = await orch.run("Task");

      // Only wave 1 should have wave_start (wave 2 is entirely skipped)
      const waveStarts = events.filter((e) => e.type === "wave_start");
      expect(waveStarts).toHaveLength(1);
      expect((waveStarts[0] as any).wave).toBe(1);

      expect(result.manifests).toHaveLength(0);
      expect(result.failures).toHaveLength(2);
      expect(result.skipped).toHaveLength(2);
    });
  });

  // ── Mixed scenarios ──────────────────────────────────────

  describe("mixed scenarios", () => {
    it("retry succeeds then dependent runs", async () => {
      let aAttempts = 0;
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") {
          aAttempts++;
          if (aAttempts < 2) throw new Error("Temporary failure");
        }
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [agent("a"), agent("b", ["a"])],
        model: TEST_MODEL,
        retry: { maxAttempts: 1, initialDelayMs: 1 },
      });

      const result = await orch.run("Task");

      expect(result.success).toBe(true);
      expect(result.manifests.map((m) => m.agent).sort()).toEqual(["a", "b"]);
    });

    it("retry exhausted then dependent skipped (continue mode)", async () => {
      mockRunAgent.mockImplementation(async (def: AgentDefinition) => {
        if (def.name === "a") throw new Error("Always fails");
        return manifest(def.name);
      });

      const orch = new Orchestrator({
        agents: [agent("a"), agent("b", ["a"]), agent("c")],
        model: TEST_MODEL,
        retry: { maxAttempts: 1, initialDelayMs: 1 },
        failureMode: "continue",
      });

      const result = await orch.run("Task");

      expect(result.manifests.map((m) => m.agent)).toEqual(["c"]);
      expect(result.failures.map((f) => f.agent)).toEqual(["a"]);
      expect(result.skipped.map((s) => s.agent)).toEqual(["b"]);
    });
  });
>>>>>>> 32c01bf (feat: update orchestrator progress events to include wave names and total execution time)
});
