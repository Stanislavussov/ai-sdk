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
    expect(prompt).toContain("## Context from upstream agents");
    expect(prompt).toContain(ctx);
  });

  it("includes responsibility guidelines", () => {
    const prompt = buildAgentSystemPrompt(agent(), "");
    expect(prompt).toContain("Stay strictly within your layer");
    expect(prompt).toContain("do not modify files owned by other agents");
    expect(prompt).toContain("write a manifest JSON file");
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

  it("includes the required manifest schema description", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("changedFiles");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("exports");
  });

  it("tells the agent not to stop until manifest is written", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("Do not respond with completion until the manifest file has been written");
  });

  it("mentions no markdown fences", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("no markdown code fences");
  });

  it("has a Task section header", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("## Task");
  });

  it("has a Required manifest section header", () => {
    const prompt = buildOrchestratorTaskPrompt("task", "/tmp/m.json");
    expect(prompt).toContain("CRITICAL REQUIREMENT");
  });
});
