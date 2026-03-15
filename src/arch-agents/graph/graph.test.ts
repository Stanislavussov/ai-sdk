import { describe, it, expect } from "vitest";
import { buildDependencyGraph } from "./graph.js";
import type { AgentDefinition } from "../types.js";

function agent(name: string, dependsOn?: string[]): AgentDefinition {
  return { name, role: `${name} role`, rules: `${name} rules`, dependsOn };
}

describe("buildDependencyGraph", () => {
  // ── Basic topology ───────────────────────────────────────

  it("puts a single agent into one wave", () => {
    const result = buildDependencyGraph([agent("a")]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].map((a) => a.name)).toEqual(["a"]);
  });

  it("puts independent agents into the same wave", () => {
    const result = buildDependencyGraph([agent("a"), agent("b"), agent("c")]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].map((a) => a.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("puts dependent agents in later waves", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b", ["a"]),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].map((a) => a.name)).toEqual(["a"]);
    expect(result.waves[1].map((a) => a.name)).toEqual(["b"]);
  });

  it("handles a linear chain of three agents", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b", ["a"]),
      agent("c", ["b"]),
    ]);
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0].map((a) => a.name)).toEqual(["a"]);
    expect(result.waves[1].map((a) => a.name)).toEqual(["b"]);
    expect(result.waves[2].map((a) => a.name)).toEqual(["c"]);
  });

  it("handles a diamond dependency graph", () => {
    // a → b, a → c, b → d, c → d
    const result = buildDependencyGraph([
      agent("a"),
      agent("b", ["a"]),
      agent("c", ["a"]),
      agent("d", ["b", "c"]),
    ]);
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0].map((a) => a.name)).toEqual(["a"]);
    expect(result.waves[1].map((a) => a.name).sort()).toEqual(["b", "c"]);
    expect(result.waves[2].map((a) => a.name)).toEqual(["d"]);
  });

  it("handles multiple roots merging into one sink", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b"),
      agent("c", ["a", "b"]),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].map((a) => a.name).sort()).toEqual(["a", "b"]);
    expect(result.waves[1].map((a) => a.name)).toEqual(["c"]);
  });

  it("handles agent depending on multiple predecessors in different waves", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b", ["a"]),
      agent("c", ["a", "b"]),
    ]);
    // c depends on both a (wave 0) and b (wave 1), so c must be in wave 2
    expect(result.waves).toHaveLength(3);
    expect(result.waves[2].map((a) => a.name)).toEqual(["c"]);
  });

  it("handles complex wide graph", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b"),
      agent("c", ["a"]),
      agent("d", ["b"]),
      agent("e", ["c", "d"]),
    ]);
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0].map((a) => a.name).sort()).toEqual(["a", "b"]);
    expect(result.waves[1].map((a) => a.name).sort()).toEqual(["c", "d"]);
    expect(result.waves[2].map((a) => a.name)).toEqual(["e"]);
  });

  // ── Deduplication of dependsOn ───────────────────────────

  it("deduplicates repeated entries in dependsOn", () => {
    const result = buildDependencyGraph([
      agent("a"),
      agent("b", ["a", "a", "a"]),
    ]);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[1].map((a) => a.name)).toEqual(["b"]);
  });

  // ── Empty input ──────────────────────────────────────────

  it("returns empty waves for empty input", () => {
    const result = buildDependencyGraph([]);
    expect(result.waves).toHaveLength(0);
  });

  // ── Preserves full agent definitions ─────────────────────

  it("preserves all agent fields in the output", () => {
    const def: AgentDefinition = {
      name: "x",
      role: "x role",
      rules: "x rules",
      dependsOn: [],
      model: "anthropic/claude-sonnet-4-5",
      type: "readonly",
      enabledTools: ["read"],
      thinkingLevel: "high",
    };
    const result = buildDependencyGraph([def]);
    expect(result.waves[0][0]).toBe(def);
  });

  // ── Error cases ──────────────────────────────────────────

  it("throws on duplicate agent names", () => {
    expect(() =>
      buildDependencyGraph([agent("a"), agent("a")]),
    ).toThrow("Duplicate agent name: a");
  });

  it("throws on unknown dependency", () => {
    expect(() =>
      buildDependencyGraph([agent("a", ["nonexistent"])]),
    ).toThrow('Unknown dependency "nonexistent" referenced by agent "a"');
  });

  it("throws on simple two-node cycle", () => {
    expect(() =>
      buildDependencyGraph([
        agent("a", ["b"]),
        agent("b", ["a"]),
      ]),
    ).toThrow(/Cycle detected/);
  });

  it("throws on self-loop", () => {
    expect(() =>
      buildDependencyGraph([agent("a", ["a"])]),
    ).toThrow(/Cycle detected/);
  });

  it("throws on three-node cycle", () => {
    expect(() =>
      buildDependencyGraph([
        agent("a", ["c"]),
        agent("b", ["a"]),
        agent("c", ["b"]),
      ]),
    ).toThrow(/Cycle detected/);
  });

  it("includes cycle path in error message", () => {
    try {
      buildDependencyGraph([
        agent("a", ["b"]),
        agent("b", ["a"]),
      ]);
      expect.fail("should have thrown");
    } catch (err: any) {
      // The error message should contain the cycle nodes
      expect(err.message).toContain("a");
      expect(err.message).toContain("b");
      expect(err.message).toContain("→");
    }
  });

  it("detects cycle in subgraph while rest is valid", () => {
    expect(() =>
      buildDependencyGraph([
        agent("root"),
        agent("a", ["root", "b"]),
        agent("b", ["a"]),
      ]),
    ).toThrow(/Cycle detected/);
  });
});
