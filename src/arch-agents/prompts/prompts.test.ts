import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt, buildOrchestratorTaskPrompt } from "./prompts.js";
import type { AgentDefinition } from "../types.js";

function agent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "schema",
    role: "database schema layer",
    rules: "Use Prisma for all schema definitions.",
    ...overrides,
  };
}

describe("buildAgentSystemPrompt", () => {
  it("includes the agent name", () => {
    const prompt = buildAgentSystemPrompt(agent(), "no context");
    expect(prompt).toContain("You are the schema agent");
  });

  it("includes the agent role", () => {
    const prompt = buildAgentSystemPrompt(agent(), "no context");
    expect(prompt).toContain("database schema layer");
  });

  it("includes the rules", () => {
    const prompt = buildAgentSystemPrompt(agent(), "no context");
    expect(prompt).toContain("Use Prisma for all schema definitions.");
  });

  it("includes the dependency context", () => {
    const ctx = "## Output from [upstream]\nDid important things";
    const prompt = buildAgentSystemPrompt(agent(), ctx);
    expect(prompt).toContain("## Upstream Context");
    expect(prompt).toContain(ctx);
  });

  it("includes manifest instructions for write agents", () => {
    const prompt = buildAgentSystemPrompt(agent(), "");
    expect(prompt).toContain("manifest file");
    expect(prompt).toContain("'write' tool");
  });

  it("includes code-intel section by default", () => {
    const prompt = buildAgentSystemPrompt(agent(), "");
    expect(prompt).toContain("code_map");
    expect(prompt).toContain("code_outline");
    expect(prompt).toContain("find_references");
  });

  it("omits code-intel when disabled via enabledTools", () => {
    const prompt = buildAgentSystemPrompt(agent({ enabledTools: ["read", "write"] }), "");
    expect(prompt).not.toContain("code_map");
    expect(prompt).not.toContain("code-intel");
  });

  it("includes skip rule", () => {
    const prompt = buildAgentSystemPrompt(agent(), "");
    expect(prompt).toContain("SKIP: not in my scope");
  });

  it("uses different agent names correctly", () => {
    const prompt = buildAgentSystemPrompt(
      agent({ name: "api", role: "REST API layer" }),
      "",
    );
    expect(prompt).toContain("You are the api agent");
    expect(prompt).toContain("REST API layer");
  });

  it("handles multi-line rules", () => {
    const rules = "Rule 1: Do X\nRule 2: Do Y\nRule 3: Do Z";
    const prompt = buildAgentSystemPrompt(agent({ rules }), "");
    expect(prompt).toContain("Rule 1: Do X");
    expect(prompt).toContain("Rule 2: Do Y");
    expect(prompt).toContain("Rule 3: Do Z");
  });

  it("includes sibling boundaries when siblings are provided", () => {
    const siblings: AgentDefinition[] = [
      { name: "i18n", role: "Internationalization. Works in packages/core/src/i18n/", rules: "" },
      { name: "translation", role: "Translates words. Works in packages/core/src/translation/", rules: "" },
      { name: "validation", role: "Validates AI responses. Works in packages/core/src/validation/", rules: "" },
    ];
    const prompt = buildAgentSystemPrompt(siblings[0], "", siblings);

    // Should list the OTHER agents, not itself
    expect(prompt).toContain("**translation**");
    expect(prompt).toContain("**validation**");
    expect(prompt).not.toContain("**i18n**");

    // Should contain the off-limits header
    expect(prompt).toContain("OFF-LIMITS");
  });

  it("omits sibling section when no siblings provided", () => {
    const prompt = buildAgentSystemPrompt(agent(), "ctx");
    expect(prompt).not.toContain("OFF-LIMITS");
  });

  it("omits sibling section when agent is the only sibling", () => {
    const def = agent();
    const prompt = buildAgentSystemPrompt(def, "ctx", [def]);
    expect(prompt).not.toContain("OFF-LIMITS");
  });
});

describe("buildOrchestratorTaskPrompt", () => {
  it("includes the task text", () => {
    const prompt = buildOrchestratorTaskPrompt("Add user authentication", "/tmp/manifest.json");
    expect(prompt).toContain("Add user authentication");
  });

  it("includes the manifest path", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/agent-manifest.json");
    expect(prompt).toContain("/tmp/agent-manifest.json");
  });

  it("includes the required manifest schema", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("changedFiles");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("exports");
  });

  it("mentions write tool requirement", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("write' tool");
  });

  it("has a Task section header", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("## Task");
  });

  it("has a Required manifest warning", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("Required");
  });
});
