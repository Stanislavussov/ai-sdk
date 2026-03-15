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
  const mockSession = {
    prompt: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    mockSession,
    mockCreateAgentSession: vi.fn(async () => ({ session: mockSession })),
    mockResolveModel: vi.fn(() => undefined),
    mockCreateCodingTools: vi.fn(() => [{ name: "coding-tool" }]),
    mockCreateReadOnlyTools: vi.fn(() => [{ name: "readonly-tool" }]),
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
      if (match) {
        fs.writeFileSync(match[1], JSON.stringify(manifest));
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

    await runAgent(agent({ type: "readonly" }), "task", "ctx", config());

    expect(mockCreateReadOnlyTools).toHaveBeenCalled();
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

  it('uses no tools for type "none"', async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(agent({ type: "none" }), "task", "ctx", config());

    expect(mockCreateCodingTools).not.toHaveBeenCalled();
    expect(mockCreateReadOnlyTools).not.toHaveBeenCalled();
  });

  // ── Tool resolution: enabledTools ────────────────────────

  it("uses enabledTools when specified", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ enabledTools: ["read", "bash"] }),
      "task",
      "ctx",
      config(),
    );

    expect(mockCreateReadTool).toHaveBeenCalled();
    expect(mockCreateBashTool).toHaveBeenCalled();
    expect(mockCreateEditTool).not.toHaveBeenCalled();
    expect(mockCreateCodingTools).not.toHaveBeenCalled();
  });

  it("enabledTools overrides type", async () => {
    mockSessionWritesManifest(validManifest());

    await runAgent(
      agent({ type: "all", enabledTools: ["read"] }),
      "task",
      "ctx",
      config(),
    );

    expect(mockCreateReadTool).toHaveBeenCalled();
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
      if (match) {
        fs.writeFileSync(match[1], "NOT JSON {{{");
      }
    });

    await expect(
      runAgent(agent(), "task", "ctx", config()),
    ).rejects.toThrow();
  });

  it("throws when exports is an array instead of object", async () => {
    mockSession.prompt.mockImplementation(async (taskPrompt: string) => {
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
      const match = taskPrompt.match(/Write valid JSON.*?to: (.+)/);
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
});
