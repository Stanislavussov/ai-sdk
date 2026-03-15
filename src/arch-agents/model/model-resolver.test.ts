import { describe, it, expect, vi } from "vitest";
import { resolveModel } from "./model-resolver.js";

// ── Minimal mock for ModelRegistry ─────────────────────────

function createMockRegistry(models?: Record<string, object>) {
  const store = models ?? {};
  return {
    find: vi.fn((provider: string, id: string) => {
      const key = `${provider}/${id}`;
      return store[key] ?? null;
    }),
  } as any;
}

describe("resolveModel", () => {
  // ── Undefined input ──────────────────────────────────────

  it("returns undefined when modelId is undefined", () => {
    const registry = createMockRegistry();
    expect(resolveModel(undefined, registry)).toBeUndefined();
  });

  // ── Successful resolution ────────────────────────────────

  it("resolves a valid model id", () => {
    const fakeModel = { id: "claude-sonnet-4-5" };
    const registry = createMockRegistry({
      "anthropic/claude-sonnet-4-5": fakeModel,
    });
    const result = resolveModel("anthropic/claude-sonnet-4-5", registry);
    expect(result).toBe(fakeModel);
    expect(registry.find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
  });

  it("correctly splits provider from model id at first slash", () => {
    const fakeModel = { id: "gpt-5" };
    const registry = createMockRegistry({ "openai/gpt-5": fakeModel });
    resolveModel("openai/gpt-5", registry);
    expect(registry.find).toHaveBeenCalledWith("openai", "gpt-5");
  });

  it("handles model ids with multiple slashes", () => {
    const fakeModel = { id: "model/with/slashes" };
    const registry = createMockRegistry({ "provider/model/with/slashes": fakeModel });
    resolveModel("provider/model/with/slashes", registry);
    // Should split at first slash only
    expect(registry.find).toHaveBeenCalledWith("provider", "model/with/slashes");
  });

  // ── Invalid format errors ────────────────────────────────

  it("throws on model id without slash", () => {
    const registry = createMockRegistry();
    expect(() => resolveModel("no-slash", registry)).toThrow(
      /Invalid model id "no-slash"/,
    );
  });

  it("throws on model id starting with slash", () => {
    const registry = createMockRegistry();
    expect(() => resolveModel("/model-id", registry)).toThrow(
      /Invalid model id "\/model-id"/,
    );
  });

  it("throws on model id ending with slash", () => {
    const registry = createMockRegistry();
    expect(() => resolveModel("provider/", registry)).toThrow(
      /Invalid model id "provider\/"/,
    );
  });

  it("throws on empty string", () => {
    const registry = createMockRegistry();
    expect(() => resolveModel("", registry)).toThrow(/Invalid model id/);
  });

  it("error message includes format hint", () => {
    const registry = createMockRegistry();
    try {
      resolveModel("bad", registry);
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("provider/model-id");
      expect(err.message).toContain("anthropic/claude-sonnet-4");
    }
  });

  // ── Model not found ──────────────────────────────────────

  it("throws when registry returns null", () => {
    const registry = createMockRegistry(); // empty
    expect(() => resolveModel("anthropic/nonexistent", registry)).toThrow(
      /Model not found: anthropic\/nonexistent/,
    );
  });

  // ── Registry throws ──────────────────────────────────────

  it("wraps registry errors with context", () => {
    const registry = {
      find: vi.fn(() => {
        throw new Error("Connection refused");
      }),
    } as any;
    expect(() => resolveModel("openai/gpt-5", registry)).toThrow(
      /Failed to resolve model "openai\/gpt-5": Connection refused/,
    );
  });

  it("wraps non-Error registry throws", () => {
    const registry = {
      find: vi.fn(() => {
        throw "string error";
      }),
    } as any;
    expect(() => resolveModel("openai/gpt-5", registry)).toThrow(
      /Failed to resolve model "openai\/gpt-5": string error/,
    );
  });
});
