import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDefinition, AgentManifest } from "../types.js";

// ── Hoisted mocks ──────────────────────────────────────────

const {
  mockSession,
  mockCreateAgentSession,
  mockResolveModel,
  mockCreateCodingTools,
  mockCreateReadOnlyTools,
  mockCreateReadTool,
  mockCreateBashTool,
  mockCreateEditTool,
  mockCreateWriteTool,
  mockCreateGrepTool,
  mockCreateFindTool,
  mockCreateLsTool,
  mockResourceLoader,
  mockAuthStorageCreate,
} = vi.hoisted(() => {
  /** Captured session event listeners (populated by subscribe()) */
  let sessionListeners: Array<(e: any) => void> = [];

  const mockSession = {
    prompt: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn((listener: (e: any) => void) => {
      sessionListeners.push(listener);
      return () => {
        sessionListeners = sessionListeners.filter((l) => l !== listener);
      };
    }),
    /** Test helper: emit an event to all current subscribers */
    _emit(event: any) {
      for (const l of sessionListeners) l(event);
    },
    /** Test helper: reset subscribers */
    _resetListeners() {
      sessionListeners = [];
    },
  };
  return {
    mockSession,
    mockCreateAgentSession: vi.fn(async () => ({ session: mockSession })),
    mockResolveModel: vi.fn(() => undefined),
    mockCreateCodingTools: vi.fn(() => [
      { name: "read" },
      { name: "bash" },
      { name: "edit" },
      { name: "write" }
    ]),
    mockCreateReadOnlyTools: vi.fn(() => [{ name: "read" }]),
    mockCreateReadTool: vi.fn(() => ({ name: "read" })),
    mockCreateBashTool: vi.fn(() => ({ name: "bash" })),
    mockCreateEditTool: vi.fn(() => ({ name: "edit" })),
    mockCreateWriteTool: vi.fn(() => ({ name: "write" })),
    mockCreateGrepTool: vi.fn(() => ({ name: "grep" })),
    mockCreateFindTool: vi.fn(() => ({ name: "find" })),
    mockCreateLsTool: vi.fn(() => ({ name: "ls" })),
    mockResourceLoader: {
      reload: vi.fn(async () => {}),
    },
    mockAuthStorageCreate: vi.fn(() => ({})),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: { create: mockAuthStorageCreate, inMemory: vi.fn(() => { throw new Error("AuthStorage.inMemory must not be used — use AuthStorage.create() to read credentials from ~/.pi/agent/auth.json"); }) },
  createAgentSession: mockCreateAgentSession,
  createBashTool: mockCreateBashTool,
  createCodingTools: mockCreateCodingTools,
  createEditTool: mockCreateEditTool,
  createFindTool: mockCreateFindTool,
  createGrepTool: mockCreateGrepTool,
  createLsTool: mockCreateLsTool,
  createReadOnlyTools: mockCreateReadOnlyTools,
  createReadTool: mockCreateReadTool,
  createWriteTool: mockCreateWriteTool,
  DefaultResourceLoader: class {
    reload = mockResourceLoader.reload;
    constructor(_opts?: any) {}
  },
  ModelRegistry: class {
    find = vi.fn();
    constructor(_auth?: any) {}
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock("../model/model-resolver.js", () => ({
  resolveModel: mockResolveModel,
}));

// Import after mocks
import { runAgent } from "./agent-factory.js";

// ── Helpers ────────────────────────────────────────────────

function agent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "test-agent",
    role: "test role",
    rules: "test rules",
    ...overrides,
  };
}

function validManifest(agentName: string = "test-agent"): AgentManifest {
  return {
    agent: agentName,
    changedFiles: ["file.ts"],
    summary: "Did stuff",
    exports: { Foo: "file.ts:1" },
  };
}

let tmpDir: string;

function config(overrides?: Record<string, any>) {
  return {
    agents: [],
    model: "anthropic/claude-sonnet-4-5",
    manifestDir: tmpDir,
    ...overrides,
  };
}

describe("runAgent", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-factory-test-"));
    mockSession.prompt.mockReset();
    mockSession.dispose.mockReset();
    mockSession.subscribe.mockClear();
    mockSession._resetListeners();
    mockCreateAgentSession.mockClear();
    mockCreateCodingTools.mockClear();
    mockCreateReadOnlyTools.mockClear();
    mockCreateReadTool.mockClear();
    mockCreateBashTool.mockClear();
    mockCreateEditTool.mockClear();
    mockCreateWriteTool.mockClear();
    mockCreateGrepTool.mockClear();
    mockCreateFindTool.mockClear();
    mockCreateLsTool.mockClear();
    mockResolveModel.mockClear();
    mockResourceLoader.reload.mockClear();
    mockAuthStorageCreate.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to make the session write a valid manifest file
  function mockSessionWritesManifest(manifest: AgentManifest) {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      // Extract the manifest path from the task prompt
      // Matches both old format: "Write valid JSON ... to: /path" 
      // and new format: "Use the 'write' tool to create the file: /path"
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(match[1].trim(), JSON.stringify(manifest));
      }
    });
  }

  // ── Happy path ───────────────────────────────────────────

  it("returns parsed manifest on success", async () => {
    const m = validManifest();
    mockSessionWritesManifest(m);

    const result = await runAgent(agent(), "Do stuff", "no context", config());

    expect(result).toEqual(m);
  });

  it("disposes session after execution", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "Do stuff", "no context", config());

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it("disposes session even when prompt throws", async () => {
    mockSession.prompt.mockRejectedValue(new Error("Prompt failed"));

    await expect(
      runAgent(agent(), "Do stuff", "no context", config()),
    ).rejects.toThrow();

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it("cleans up manifest file after reading", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "Do stuff", "no context", config());

    // The manifest file should have been deleted
    const files = fs.readdirSync(tmpDir);
    const manifestFiles = files.filter((f) => f.includes("test-agent-manifest"));
    expect(manifestFiles).toHaveLength(0);
  });

  // ── Auth storage ──────────────────────────────────────────

  it("uses AuthStorage.create() to read credentials from disk", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "task", "ctx", config());

    expect(mockAuthStorageCreate).toHaveBeenCalled();
  });

  // ── Tool resolution: type presets ────────────────────────

  it('uses coding tools for type "coding" (default)', async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "task", "ctx", config());

    expect(mockCreateCodingTools).toHaveBeenCalled();
  });

  it('uses coding tools when type is not specified', async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent({ type: undefined }), "task", "ctx", config());

    expect(mockCreateCodingTools).toHaveBeenCalled();
  });

  it('uses readonly tools for type "readonly"', async () => {
    mockSessionWritesManifest(validManifest());

    // Must add write tool since readonly doesn't include it
    await runAgent(agent({ type: "readonly", enabledTools: ["read", "write"] }), "task", "ctx", config());

    expect(mockCreateReadTool).toHaveBeenCalled();
    expect(mockCreateWriteTool).toHaveBeenCalled();
  });

  it('uses all tools for type "all"', async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent({ type: "all" }), "task", "ctx", config());

    // Should create all individual tools
    expect(mockCreateReadTool).toHaveBeenCalled();
    expect(mockCreateBashTool).toHaveBeenCalled();
    expect(mockCreateEditTool).toHaveBeenCalled();
    expect(mockCreateWriteTool).toHaveBeenCalled();
    expect(mockCreateGrepTool).toHaveBeenCalled();
    expect(mockCreateFindTool).toHaveBeenCalled();
    expect(mockCreateLsTool).toHaveBeenCalled();
  });

  it('throws for type "none" without write tool', async () => {
    mockSessionWritesManifest(validManifest());

    await expect(
      runAgent(agent({ type: "none" }), "task", "ctx", config())
    ).rejects.toThrow(/must have the "write" tool/);

    expect(mockCreateCodingTools).not.toHaveBeenCalled();
    expect(mockCreateReadOnlyTools).not.toHaveBeenCalled();
  });

  // ── Tool resolution: enabledTools ────────────────────────

  it("uses enabledTools when specified", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ enabledTools: ["read", "bash", "write"] }),
      "task",
      "ctx",
      config(),
    );

    expect(mockCreateReadTool).toHaveBeenCalled();
    expect(mockCreateBashTool).toHaveBeenCalled();
    expect(mockCreateWriteTool).toHaveBeenCalled();
    expect(mockCreateEditTool).not.toHaveBeenCalled();
    expect(mockCreateCodingTools).not.toHaveBeenCalled();
  });

  it("enabledTools overrides type", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ type: "all", enabledTools: ["read", "write"] }),
      "task",
      "ctx",
      config(),
    );

    expect(mockCreateReadTool).toHaveBeenCalled();
    expect(mockCreateWriteTool).toHaveBeenCalled();
    expect(mockCreateBashTool).not.toHaveBeenCalled();
  });

  it("throws on unknown tool in enabledTools", async () => {
    await expect(
      runAgent(
        agent({ enabledTools: ["magic_wand"] }),
        "task",
        "ctx",
        config(),
      ),
    ).rejects.toThrow(/unknown tool "magic_wand"/);
  });

  // ── Manifest parsing errors ──────────────────────────────

  it("throws when manifest file is not written", async () => {
    mockSession.prompt.mockResolvedValue(undefined);

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/did not write manifest file/);
  });

  it("throws when manifest has invalid changedFiles", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: "not-an-array",
            summary: "ok",
            exports: {},
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/changedFiles must be string\[\]/);
  });

  it("throws when manifest has non-string summary", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: [],
            summary: 123,
            exports: {},
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/summary must be string/);
  });

  it("throws when manifest has invalid exports", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: [],
            summary: "ok",
            exports: "not-an-object",
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/exports must be Record/);
  });

  it("throws when exports contains non-string value", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: [],
            summary: "ok",
            exports: { key: 42 },
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/exports\.key must be string/);
  });

  it("throws when manifest is not valid JSON", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(match[1].trim(), "NOT JSON {{{");
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow();
  });

  it("throws when exports is an array instead of object", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: [],
            summary: "ok",
            exports: ["not", "an", "object"],
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/exports must be Record/);
  });

  it("throws when exports is null", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: [],
            summary: "ok",
            exports: null,
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/exports must be Record/);
  });

  it("throws when changedFiles contains non-string elements", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
      if (match) {
        fs.writeFileSync(
          match[1],
          JSON.stringify({
            changedFiles: ["ok.ts", 42],
            summary: "ok",
            exports: {},
          }),
        );
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow(/changedFiles must be string\[\]/);
  });

  // ── Model resolution ─────────────────────────────────────

  it("calls resolveModel with agent model", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ model: "anthropic/claude-sonnet-4-5" }),
      "task",
      "ctx",
      config(),
    );

    expect(mockResolveModel).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4-5",
      expect.any(Object),
    );
  });

  it("falls back to config model when agent has no model", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "task", "ctx", config({ model: "openai/gpt-5" }));

    expect(mockResolveModel).toHaveBeenCalledWith(
      "openai/gpt-5",
      expect.any(Object),
    );
  });

  it("passes thinkingLevel to createAgentSession", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ thinkingLevel: "high" }),
      "task",
      "ctx",
      config(),
    );

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "high" }),
    );
  });

  it("falls back to config thinkingLevel", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent(), "task", "ctx", config({ thinkingLevel: "medium" }));

    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "medium" }),
    );
  });

  // ── Agent activity events ────────────────────────────────

  describe("agent_activity progress events", () => {
    function mockSessionWithEvents(manifest: AgentManifest, events: any[]) {
      mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
        // Emit events during prompt execution
        for (const e of events) mockSession._emit(e);

        const match = taskPrompt.match(/(?:to create the file|to): ([^\n]+)/);
        if (match) {
          fs.writeFileSync(match[1].trim(), JSON.stringify(manifest));
        }
      });
    }

    it("subscribes to session events when onProgress is provided", async () => {
      mockSessionWithEvents(validManifest(), []);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(mockSession.subscribe).toHaveBeenCalled();
    });

    it("does not subscribe when onProgress is absent", async () => {
      mockSessionWritesManifest(validManifest());

      await runAgent(agent(), "task", "ctx", config());

      expect(mockSession.subscribe).not.toHaveBeenCalled();
    });

    it("emits agent_activity for message_start (thinking)", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "message_start", message: {} },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "🧠 Thinking…",
      });
    });

    it("emits agent_activity for read tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Read", args: { path: "src/index.ts" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "📖 Reading src/index.ts",
      });
    });

    it("emits agent_activity for bash tool with command", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Bash", args: { command: "npm test" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "⚡ Running: npm test",
      });
    });

    it("emits agent_activity for edit tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Edit", args: { path: "src/foo.ts" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "✏️ Editing src/foo.ts",
      });
    });

    it("emits agent_activity for write tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Write", args: { path: "new-file.ts" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "📝 Writing new-file.ts",
      });
    });

    it("emits agent_activity for grep tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Grep", args: { pattern: "TODO" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: '🔍 Searching for "TODO"',
      });
    });

    it("emits agent_activity for find tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Find", args: { pattern: "*.test.ts" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: '🔎 Finding files matching "*.test.ts"',
      });
    });

    it("emits agent_activity for ls tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Ls", args: { path: "src/" } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "📂 Listing src/",
      });
    });

    it("emits agent_activity for unknown custom tool", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "deploy", args: {} },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "🔧 Using tool: deploy",
      });
    });

    it("emits agent_activity for tool failure", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_end", toolCallId: "1", toolName: "Bash", result: {}, isError: true },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(onProgress).toHaveBeenCalledWith({
        type: "agent_activity",
        agent: "test-agent",
        message: "❌ Tool Bash failed",
      });
    });

    it("does not emit agent_activity for successful tool_execution_end", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_end", toolCallId: "1", toolName: "Read", result: {}, isError: false },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      const activityEvents = onProgress.mock.calls
        .map(([e]: any) => e)
        .filter((e: any) => e.type === "agent_activity");
      expect(activityEvents).toHaveLength(0);
    });

    it("does not emit agent_activity for irrelevant events", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "turn_start" },
        { type: "turn_end", message: {}, toolResults: [] },
        { type: "agent_end", messages: [] },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      const activityEvents = onProgress.mock.calls
        .map(([e]: any) => e)
        .filter((e: any) => e.type === "agent_activity");
      expect(activityEvents).toHaveLength(0);
    });

    it("unsubscribes from session events after completion", async () => {
      const unsubscribe = vi.fn();
      mockSession.subscribe.mockReturnValueOnce(unsubscribe);
      mockSessionWithEvents(validManifest(), []);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      expect(unsubscribe).toHaveBeenCalled();
    });

    it("unsubscribes from session events even on error", async () => {
      const unsubscribe = vi.fn();
      mockSession.subscribe.mockReturnValueOnce(unsubscribe);
      mockSession.prompt.mockRejectedValue(new Error("Boom"));
      const onProgress = vi.fn();

      await expect(
        runAgent(agent(), "task", "ctx", config({ onProgress })),
      ).rejects.toThrow();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it("handles lowercase tool names (e.g. from custom tools)", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "README.md" } },
        { type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "ls" } },
        { type: "tool_execution_start", toolCallId: "3", toolName: "edit", args: { path: "x.ts" } },
        { type: "tool_execution_start", toolCallId: "4", toolName: "write", args: { path: "y.ts" } },
        { type: "tool_execution_start", toolCallId: "5", toolName: "grep", args: { pattern: "foo" } },
        { type: "tool_execution_start", toolCallId: "6", toolName: "find", args: { pattern: "*.md" } },
        { type: "tool_execution_start", toolCallId: "7", toolName: "ls", args: { path: "." } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      const activities = onProgress.mock.calls
        .map(([e]: any) => e)
        .filter((e: any) => e.type === "agent_activity")
        .map((e: any) => e.message);

      expect(activities).toEqual([
        "📖 Reading README.md",
        "⚡ Running: ls",
        "✏️ Editing x.ts",
        "📝 Writing y.ts",
        '🔍 Searching for "foo"',
        '🔎 Finding files matching "*.md"',
        "📂 Listing .",
      ]);
    });

    it("truncates long bash commands to 120 chars", async () => {
      const longCmd = "a".repeat(200);
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Bash", args: { command: longCmd } },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      const activity = onProgress.mock.calls
        .map(([e]: any) => e)
        .find((e: any) => e.type === "agent_activity");

      expect(activity.message).toBe(`⚡ Running: ${"a".repeat(120)}`);
    });

    it("handles missing args gracefully", async () => {
      mockSessionWithEvents(validManifest(), [
        { type: "tool_execution_start", toolCallId: "1", toolName: "Read", args: {} },
        { type: "tool_execution_start", toolCallId: "2", toolName: "Bash", args: {} },
        { type: "tool_execution_start", toolCallId: "3", toolName: "Grep", args: {} },
        { type: "tool_execution_start", toolCallId: "4", toolName: "Find", args: {} },
        { type: "tool_execution_start", toolCallId: "5", toolName: "Ls", args: {} },
      ]);
      const onProgress = vi.fn();

      await runAgent(agent(), "task", "ctx", config({ onProgress }));

      const activities = onProgress.mock.calls
        .map(([e]: any) => e)
        .filter((e: any) => e.type === "agent_activity")
        .map((e: any) => e.message);

      expect(activities).toEqual([
        "📖 Reading a file",
        "⚡ Running a command",
        "🔍 Searching files",
        "🔎 Finding files",
        "📂 Listing directory",
      ]);
    });
  });
});
