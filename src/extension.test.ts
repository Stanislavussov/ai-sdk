import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Hoisted mocks (available before vi.mock factories) ─────
const { mockRun, mockCreateOrchestrator, mockRunAgent } = vi.hoisted(() => {
  const mockRun = vi.fn();
  const mockCreateOrchestrator = vi.fn(() => ({ run: mockRun }));
  const mockRunAgent = vi.fn();
  return { mockRun, mockCreateOrchestrator, mockRunAgent };
});

// ── Mock pi-coding-agent + pi-agent-core + typebox ─────────
vi.mock("@mariozechner/pi-coding-agent", () => ({}));
vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (schema: any) => schema,
    String: (opts?: any) => ({ type: "string", ...opts }),
    Boolean: (opts?: any) => ({ type: "boolean", ...opts }),
    Optional: (inner: any) => ({ ...inner, optional: true }),
    Array: (inner: any, opts?: any) => ({ type: "array", items: inner, ...opts }),
  },
}));

// ── Mock arch-agents/index.js ──────────────────────────────
vi.mock("./arch-agents/index.js", () => ({
  createOrchestrator: mockCreateOrchestrator,
}));

// ── Mock arch-agents/agent-factory.js ──────────────────────
vi.mock("./arch-agents/agent/agent-factory.js", () => ({
  runAgent: mockRunAgent,
}));

// ── Import the extension under test ────────────────────────
import extensionFn from "./extension.js";

// ── Helpers: fake ExtensionAPI ─────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
  [key: string]: any;
}

interface RegisteredCommand {
  description: string;
  handler: (args: string | undefined, ctx: any) => Promise<void>;
}

function createFakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, Function>();
  const sentMessages: Array<{ text: string; opts: any }> = [];

  return {
    on: vi.fn((event: string, handler: Function) => {
      events.set(event, handler);
    }),
    registerTool: vi.fn((toolDef: RegisteredTool) => {
      tools.set(toolDef.name, toolDef);
    }),
    registerCommand: vi.fn((name: string, def: RegisteredCommand) => {
      commands.set(name, def);
    }),
    sendUserMessage: vi.fn((text: string, opts: any) => {
      sentMessages.push({ text, opts });
    }),

    // Test helpers
    _tools: tools,
    _commands: commands,
    _events: events,
    _sentMessages: sentMessages,
  };
}

// ── Test suite ─────────────────────────────────────────────

describe("extension.ts", () => {
  let pi: ReturnType<typeof createFakePi>;
  let tmpDir: string;

  beforeEach(() => {
    pi = createFakePi();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-test-"));
    mockCreateOrchestrator.mockClear();
    mockRun.mockClear();
    mockRunAgent.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Registration tests ─────────────────────────────────

  describe("registration", () => {
    it("registers session_start event handler", () => {
      extensionFn(pi as any);
      expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    });

    it("registers 'orchestrate' tool", () => {
      extensionFn(pi as any);
      expect(pi._tools.has("orchestrate")).toBe(true);
    });

    it("registers 'run_agent' tool", () => {
      extensionFn(pi as any);
      expect(pi._tools.has("run_agent")).toBe(true);
    });

    it("registers 'orchestrate' command", () => {
      extensionFn(pi as any);
      expect(pi._commands.has("orchestrate")).toBe(true);
    });

    it("registers 'agent' command", () => {
      extensionFn(pi as any);
      expect(pi._commands.has("agent")).toBe(true);
    });

    it("registers 'orch-agents' command", () => {
      extensionFn(pi as any);
      expect(pi._commands.has("orch-agents")).toBe(true);
    });
  });

  // ── Config loading (session_start) ─────────────────────

  describe("session_start / loadConfig", () => {
    it("loads config from .pi/settings.json", async () => {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({
          orchestrator: {
            model: "anthropic/claude-sonnet-4-5",
            agents: [
              { name: "schema", role: "Schema agent", rules: "Use Prisma" },
            ],
          },
        }),
      );

      const ctx = {
        cwd: tmpDir,
        ui: { notify: vi.fn() },
      };

      const handler = pi._events.get("session_start")!;
      await handler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("1 agents"),
        "info",
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("schema"),
        "info",
      );
    });

    it("handles missing .pi/settings.json gracefully", async () => {
      extensionFn(pi as any);

      const ctx = {
        cwd: tmpDir,
        ui: { notify: vi.fn() },
      };

      const handler = pi._events.get("session_start")!;
      await handler({}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("handles invalid JSON in settings file", async () => {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(path.join(piDir, "settings.json"), "NOT VALID JSON");

      const ctx = {
        cwd: tmpDir,
        ui: { notify: vi.fn() },
      };

      const handler = pi._events.get("session_start")!;
      await handler({}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("handles settings.json without orchestrator key", async () => {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({ theme: "dark" }),
      );

      const ctx = {
        cwd: tmpDir,
        ui: { notify: vi.fn() },
      };

      const handler = pi._events.get("session_start")!;
      await handler({}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("handles orchestrator without agents array", async () => {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({ orchestrator: { model: "foo" } }),
      );

      const ctx = {
        cwd: tmpDir,
        ui: { notify: vi.fn() },
      };

      const handler = pi._events.get("session_start")!;
      await handler({}, ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });
  });

  // ── orchestrate tool ───────────────────────────────────

  describe("orchestrate tool", () => {
    function setupWithConfig(agents: any[], model: string = "anthropic/claude-sonnet-4-5") {
      extensionFn(pi as any);

      // Simulate session_start to load config
      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({
          orchestrator: { model, agents },
        }),
      );

      const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
      const handler = pi._events.get("session_start")!;
      return handler({}, ctx).then(() => pi._tools.get("orchestrate")!);
    }

    it("runs orchestration with config agents and returns manifests", async () => {
      const manifests = [
        {
          agent: "schema",
          changedFiles: ["prisma/schema.prisma"],
          summary: "Added User model",
          exports: { UserModel: "prisma/schema.prisma:10" },
        },
      ];
      mockRun.mockResolvedValue(manifests);

      const tool = await setupWithConfig(
        [{ name: "schema", role: "Schema agent", rules: "Use Prisma" }],
        "anthropic/claude-sonnet-4-5",
      );

      const onUpdate = vi.fn();
      const result = await tool.execute(
        "call-1",
        { task: "Add user auth" },
        new AbortController().signal,
        onUpdate,
        { cwd: tmpDir },
      );

      expect(mockCreateOrchestrator).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [{ name: "schema", role: "Schema agent", rules: "Use Prisma" }],
          model: "anthropic/claude-sonnet-4-5",
          cwd: tmpDir,
        }),
      );
      expect(mockRun).toHaveBeenCalledWith("Add user auth");
      expect(result.content[0].text).toContain("Orchestration complete");
      expect(result.content[0].text).toContain("Added User model");
      expect(result.details.manifests).toEqual(manifests);
    });

    it("uses inline agents when no config agents exist", async () => {
      extensionFn(pi as any);
      const tool = pi._tools.get("orchestrate")!;

      const manifests = [
        {
          agent: "inline-agent",
          changedFiles: [],
          summary: "Did stuff",
          exports: {},
        },
      ];
      mockRun.mockResolvedValue(manifests);

      const result = await tool.execute(
        "call-2",
        {
          task: "Test task",
          model: "anthropic/claude-sonnet-4-5",
          agents: [{ name: "inline-agent", role: "Tester", rules: "Test all" }],
        },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(mockCreateOrchestrator).toHaveBeenCalled();
      expect(result.content[0].text).toContain("Orchestration complete");
    });

    it("throws when no agents are defined anywhere", async () => {
      extensionFn(pi as any);
      const tool = pi._tools.get("orchestrate")!;

      await expect(
        tool.execute(
          "call-3",
          { task: "No agents" },
          new AbortController().signal,
          vi.fn(),
          { cwd: tmpDir },
        ),
      ).rejects.toThrow("No agents defined");
    });

    it("progress handler fires wave_start events", async () => {
      const manifests = [
        { agent: "a", changedFiles: [], summary: "Done", exports: {} },
      ];
      mockRun.mockImplementation(async () => {
        // Get the onProgress from the config passed to createOrchestrator
        const calls = mockCreateOrchestrator.mock.calls as unknown as Array<[Record<string, any>]>;
        const config = calls.at(-1)![0];
        config.onProgress({ type: "wave_start", wave: 1, agents: ["a"] });
        config.onProgress({ type: "agent_start", agent: "a", model: "test/model" });
        config.onProgress({
          type: "agent_done",
          agent: "a",
          manifest: manifests[0],
        });
        config.onProgress({
          type: "orchestrator_done",
          manifests,
        });
        return manifests;
      });

      const tool = await setupWithConfig(
        [{ name: "a", role: "Agent A", rules: "Do things" }],
      );

      const onUpdate = vi.fn();
      await tool.execute(
        "call-4",
        { task: "Progress test" },
        new AbortController().signal,
        onUpdate,
        { cwd: tmpDir },
      );

      // onUpdate should have been called for each progress event
      expect(onUpdate).toHaveBeenCalled();
      const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(lastCall.content[0].text).toContain("Wave 1");
      expect(lastCall.content[0].text).toContain("✓ a: Done");
    });

    it("progress handler handles agent_error events", async () => {
      const manifests: any[] = [];
      mockRun.mockImplementation(async () => {
        const calls = mockCreateOrchestrator.mock.calls as unknown as Array<[Record<string, any>]>;
        const config = calls.at(-1)![0];
        config.onProgress({ type: "wave_start", wave: 1, agents: ["broken"] });
        config.onProgress({
          type: "agent_error",
          agent: "broken",
          error: new Error("Something failed"),
        });
        return manifests;
      });

      const tool = await setupWithConfig(
        [{ name: "broken", role: "Broken", rules: "Break" }],
      );

      const onUpdate = vi.fn();
      await tool.execute(
        "call-5",
        { task: "Error test" },
        new AbortController().signal,
        onUpdate,
        { cwd: tmpDir },
      );

      const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(lastCall.content[0].text).toContain("✗ broken: Something failed");
    });
  });

  // ── run_agent tool ─────────────────────────────────────

  describe("run_agent tool", () => {
    function setupWithConfig(agents: any[], model: string = "anthropic/claude-sonnet-4-5") {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({
          orchestrator: { model, agents },
        }),
      );

      const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
      const handler = pi._events.get("session_start")!;
      return handler({}, ctx).then(() => pi._tools.get("run_agent")!);
    }

    it("runs a named agent from config", async () => {
      const manifest = {
        agent: "schema",
        changedFiles: ["schema.prisma"],
        summary: "Added posts table",
        exports: { PostModel: "schema.prisma:20" },
      };
      mockRunAgent.mockResolvedValue(manifest);

      const tool = await setupWithConfig(
        [{ name: "schema", role: "Schema agent", rules: "Use Prisma", type: "coding" }],
        "anthropic/claude-sonnet-4-5",
      );

      const onUpdate = vi.fn();
      const result = await tool.execute(
        "call-1",
        { name: "schema", task: "Add posts table" },
        new AbortController().signal,
        onUpdate,
        { cwd: tmpDir },
      );

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "schema",
          role: "Schema agent",
          rules: "Use Prisma",
        }),
        "Add posts table",
        "You are running standalone — no upstream context.",
        expect.any(Object),
      );

      expect(result.content[0].text).toContain('Agent "schema" complete');
      expect(result.content[0].text).toContain("Added posts table");
      expect(result.content[0].text).toContain("PostModel → schema.prisma:20");
      expect(result.details.manifest).toEqual(manifest);
    });

    it("passes custom context as dependency context", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "api",
        changedFiles: [],
        summary: "Built API",
        exports: {},
      });

      const tool = await setupWithConfig(
        [{ name: "api", role: "API agent", rules: "REST" }],
      );

      await tool.execute(
        "call-2",
        {
          name: "api",
          task: "Build endpoints",
          context: "Schema has User and Post models",
        },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.any(Object),
        "Build endpoints",
        "Schema has User and Post models",
        expect.any(Object),
      );
    });

    it("allows inline agent definition with role + rules", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "custom",
        changedFiles: [],
        summary: "Custom work",
        exports: {},
      });

      extensionFn(pi as any);
      const tool = pi._tools.get("run_agent")!;

      await tool.execute(
        "call-3",
        {
          name: "custom",
          task: "Do custom thing",
          role: "Custom agent",
          rules: "Custom rules",
          type: "readonly",
          model: "anthropic/claude-sonnet-4-5",
        },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "custom",
          role: "Custom agent",
          rules: "Custom rules",
          type: "readonly",
        }),
        "Do custom thing",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("throws when agent not in config and no role provided", async () => {
      const tool = await setupWithConfig(
        [{ name: "schema", role: "Schema", rules: "Rules" }],
      );

      await expect(
        tool.execute(
          "call-4",
          { name: "unknown-agent", task: "Something" },
          new AbortController().signal,
          vi.fn(),
          { cwd: tmpDir },
        ),
      ).rejects.toThrow('Agent "unknown-agent" not found');
    });

    it("throws with available agent names in error message", async () => {
      const tool = await setupWithConfig([
        { name: "schema", role: "Schema", rules: "Rules" },
        { name: "api", role: "API", rules: "Rules" },
      ]);

      await expect(
        tool.execute(
          "call-5",
          { name: "nope", task: "Something" },
          new AbortController().signal,
          vi.fn(),
          { cwd: tmpDir },
        ),
      ).rejects.toThrow("schema, api");
    });

    it("shows (none) for empty exports", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "simple",
        changedFiles: [],
        summary: "Simple",
        exports: {},
      });

      const tool = await setupWithConfig(
        [{ name: "simple", role: "Simple", rules: "Do" }],
      );

      const result = await tool.execute(
        "call-6",
        { name: "simple", task: "Simple task" },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(result.content[0].text).toContain("Exports: (none)");
    });

    it("shows (none) for empty changedFiles", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "simple",
        changedFiles: [],
        summary: "No changes",
        exports: {},
      });

      const tool = await setupWithConfig(
        [{ name: "simple", role: "Simple", rules: "Rules" }],
      );

      const result = await tool.execute(
        "call-7",
        { name: "simple", task: "Task" },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(result.content[0].text).toContain("Files: (none)");
    });

    it("sends onUpdate with progress at start", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "a",
        changedFiles: [],
        summary: "Ok",
        exports: {},
      });

      const tool = await setupWithConfig(
        [{ name: "a", role: "A", rules: "Rules" }],
      );

      const onUpdate = vi.fn();
      await tool.execute(
        "call-8",
        { name: "a", task: "Go" },
        new AbortController().signal,
        onUpdate,
        { cwd: tmpDir },
      );

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [
            expect.objectContaining({
              text: expect.stringContaining("Running agent"),
            }),
          ],
        }),
      );
    });

    it("overrides config agent fields with inline params", async () => {
      mockRunAgent.mockResolvedValue({
        agent: "schema",
        changedFiles: [],
        summary: "Overridden",
        exports: {},
      });

      const tool = await setupWithConfig(
        [{ name: "schema", role: "Schema", rules: "Original rules", model: "openai/gpt-5" }],
      );

      await tool.execute(
        "call-9",
        {
          name: "schema",
          task: "Override test",
          role: "Overridden role",
          model: "anthropic/claude-sonnet-4-5",
        },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "schema",
          role: "Overridden role",
          rules: "Original rules", // rules not overridden
          model: "anthropic/claude-sonnet-4-5",
        }),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // ── Commands ───────────────────────────────────────────

  describe("commands", () => {
    function setupWithConfig(agents: any[]) {
      extensionFn(pi as any);

      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({ orchestrator: { model: "anthropic/claude-sonnet-4-5", agents } }),
      );

      const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
      const handler = pi._events.get("session_start")!;
      return handler({}, ctx).then(() => ctx);
    }

    describe("/orchestrate", () => {
      it("sends followUp message with task", async () => {
        await setupWithConfig([
          { name: "a", role: "A", rules: "R" },
        ]);

        const cmd = pi._commands.get("orchestrate")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("Build the thing", ctx);

        expect(pi.sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining("Build the thing"),
          { deliverAs: "followUp" },
        );
      });

      it("warns when no task given", async () => {
        await setupWithConfig([{ name: "a", role: "A", rules: "R" }]);

        const cmd = pi._commands.get("orchestrate")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Usage"),
          "warning",
        );
      });

      it("errors when no config loaded", async () => {
        extensionFn(pi as any);

        const cmd = pi._commands.get("orchestrate")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("Some task", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("No orchestrator config"),
          "error",
        );
      });
    });

    describe("/agent", () => {
      it("sends followUp message with name and task", async () => {
        await setupWithConfig([
          { name: "schema", role: "Schema", rules: "R" },
        ]);

        const cmd = pi._commands.get("agent")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("schema Add users table", ctx);

        expect(pi.sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining('name="schema"'),
          { deliverAs: "followUp" },
        );
        expect(pi.sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining("Add users table"),
          { deliverAs: "followUp" },
        );
      });

      it("warns when missing arguments", async () => {
        await setupWithConfig([
          { name: "schema", role: "Schema", rules: "R" },
        ]);

        const cmd = pi._commands.get("agent")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Usage"),
          "warning",
        );
      });

      it("warns when only name given (no space)", async () => {
        await setupWithConfig([
          { name: "schema", role: "Schema", rules: "R" },
        ]);

        const cmd = pi._commands.get("agent")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("schema", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Usage"),
          "warning",
        );
      });

      it("errors when agent name not found", async () => {
        await setupWithConfig([
          { name: "schema", role: "Schema", rules: "R" },
        ]);

        const cmd = pi._commands.get("agent")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("unknown Do stuff", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining('"unknown" not found'),
          "error",
        );
      });

      it("errors when no config loaded", async () => {
        extensionFn(pi as any);

        const cmd = pi._commands.get("agent")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler("schema Do stuff", ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("No orchestrator config"),
          "error",
        );
      });
    });

    describe("/orch-agents", () => {
      it("lists all configured agents", async () => {
        await setupWithConfig([
          { name: "schema", role: "Schema agent", rules: "R", type: "coding" },
          { name: "api", role: "API agent", rules: "R", dependsOn: ["schema"] },
        ]);

        const cmd = pi._commands.get("orch-agents")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler(undefined, ctx);

        const msg = ctx.ui.notify.mock.calls[0][0] as string;
        expect(msg).toContain("2");
        expect(msg).toContain("schema");
        expect(msg).toContain("api");
        expect(msg).toContain("depends on: schema");
      });

      it("shows 'no dependencies' for agents without deps", async () => {
        await setupWithConfig([
          { name: "standalone", role: "Solo", rules: "R" },
        ]);

        const cmd = pi._commands.get("orch-agents")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler(undefined, ctx);

        const msg = ctx.ui.notify.mock.calls[0][0] as string;
        expect(msg).toContain("no dependencies");
      });

      it("errors when no config loaded", async () => {
        extensionFn(pi as any);

        const cmd = pi._commands.get("orch-agents")!;
        const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
        await cmd.handler(undefined, ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("No orchestrator config"),
          "error",
        );
      });
    });
  });

  // ── formatManifests (via orchestrate output) ───────────

  describe("formatManifests (via orchestrate output)", () => {
    it("formats multiple manifests with exports", async () => {
      extensionFn(pi as any);

      // Load config
      const piDir = path.join(tmpDir, ".pi");
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, "settings.json"),
        JSON.stringify({
          orchestrator: {
            model: "anthropic/claude-sonnet-4-5",
            agents: [
              { name: "a", role: "A", rules: "R" },
              { name: "b", role: "B", rules: "R" },
            ],
          },
        }),
      );

      const ctx = { cwd: tmpDir, ui: { notify: vi.fn() } };
      await pi._events.get("session_start")!({}, ctx);

      const manifests = [
        {
          agent: "a",
          changedFiles: ["file1.ts", "file2.ts"],
          summary: "Created things",
          exports: { Foo: "file1.ts:5", Bar: "file2.ts:10" },
        },
        {
          agent: "b",
          changedFiles: ["file3.ts"],
          summary: "Built more stuff",
          exports: {},
        },
      ];
      mockRun.mockResolvedValue(manifests);

      const tool = pi._tools.get("orchestrate")!;
      const result = await tool.execute(
        "call-fmt",
        { task: "Format test" },
        new AbortController().signal,
        vi.fn(),
        { cwd: tmpDir },
      );

      const text = result.content[0].text;
      expect(text).toContain("[a]");
      expect(text).toContain("file1.ts, file2.ts");
      expect(text).toContain("Foo → file1.ts:5");
      expect(text).toContain("[b]");
      expect(text).toContain("Exports: (none)");
    });
  });
});
