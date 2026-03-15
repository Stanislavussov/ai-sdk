import { describe, it, expect, vi } from "vitest";

const { mockOrchestrator, constructorArgs } = vi.hoisted(() => {
  const constructorArgs: any[] = [];
  const mockOrchestrator = vi.fn().mockImplementation(function (this: any, config: any) {
    constructorArgs.push(config);
    this.run = vi.fn();
  });
  return { mockOrchestrator, constructorArgs };
});

vi.mock("./orchestrator.js", () => ({
  Orchestrator: mockOrchestrator,
}));

import { createOrchestrator } from "./orchestrator-factory.js";

describe("createOrchestrator", () => {
  it("returns an object with a run method", () => {
    const result = createOrchestrator({ agents: [] });
    expect(typeof result.run).toBe("function");
  });

  it("passes config to the Orchestrator constructor", () => {
    constructorArgs.length = 0;

    const config = {
      agents: [{ name: "a", role: "A", rules: "R" }],
      model: "openai/gpt-5" as const,
      cwd: "/tmp",
    };
    createOrchestrator(config);

    expect(constructorArgs[0]).toBe(config);
  });
});
