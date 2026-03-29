import { describe, it, expect } from "vitest";
import { ManifestBus } from "./manifest-bus.js";
import type { AgentManifest } from "../types.js";

function manifest(
  agent: string,
  opts?: Partial<Omit<AgentManifest, "agent">>,
): AgentManifest {
  return {
    agent,
    changedFiles: opts?.changedFiles ?? [],
    summary: opts?.summary ?? `${agent} summary`,
    exports: opts?.exports ?? {},
  };
}

describe("ManifestBus", () => {
  // ── set / all ────────────────────────────────────────────

  describe("set + all", () => {
    it("stores and retrieves manifests", () => {
      const bus = new ManifestBus();
      const m = manifest("a");
      bus.set(m);
      expect(bus.all()).toEqual([m]);
    });

    it("returns all stored manifests in insertion order", () => {
      const bus = new ManifestBus();
      const m1 = manifest("a");
      const m2 = manifest("b");
      bus.set(m1);
      bus.set(m2);
      expect(bus.all()).toEqual([m1, m2]);
    });

    it("overwrites manifest for the same agent name", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a", { summary: "first" }));
      bus.set(manifest("a", { summary: "second" }));
      expect(bus.all()).toHaveLength(1);
      expect(bus.all()[0].summary).toBe("second");
    });

    it("returns empty array when nothing stored", () => {
      const bus = new ManifestBus();
      expect(bus.all()).toEqual([]);
    });
  });

  // ── getContext ────────────────────────────────────────────

  describe("getContext", () => {
    it("returns no-upstream message for empty dependsOn", () => {
      const bus = new ManifestBus();
      const ctx = bus.getContext([]);
      expect(ctx).toBe("You run first — no upstream context.");
    });

    it("returns formatted context for one dependency", () => {
      const bus = new ManifestBus();
      bus.set(
        manifest("schema", {
          changedFiles: ["prisma/schema.prisma"],
          summary: "Added User model",
          exports: { UserModel: "prisma/schema.prisma:10" },
        }),
      );

      const ctx = bus.getContext(["schema"]);
      expect(ctx).toContain("## Output from [schema] agent");
      expect(ctx).toContain("Added User model");
      expect(ctx).toContain("prisma/schema.prisma");
      expect(ctx).toContain("UserModel → prisma/schema.prisma:10");
    });

    it("returns formatted context for multiple dependencies", () => {
      const bus = new ManifestBus();
      bus.set(
        manifest("schema", {
          changedFiles: ["schema.prisma"],
          summary: "Schema done",
          exports: { User: "schema.prisma:1" },
        }),
      );
      bus.set(
        manifest("api", {
          changedFiles: ["routes.ts"],
          summary: "API done",
          exports: { getUser: "routes.ts:5" },
        }),
      );

      const ctx = bus.getContext(["schema", "api"]);
      expect(ctx).toContain("[schema]");
      expect(ctx).toContain("[api]");
      expect(ctx).toContain("Schema done");
      expect(ctx).toContain("API done");
      expect(ctx).toContain("User → schema.prisma:1");
      expect(ctx).toContain("getUser → routes.ts:5");
    });

    it("shows (none) for empty changedFiles", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a", { changedFiles: [] }));
      const ctx = bus.getContext(["a"]);
      expect(ctx).toContain("Changed files: (none)");
    });

    it("shows (none) for empty exports", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a", { exports: {} }));
      const ctx = bus.getContext(["a"]);
      expect(ctx).toContain("(none)");
    });

    it("lists multiple changed files comma-separated", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a", { changedFiles: ["f1.ts", "f2.ts", "f3.ts"] }));
      const ctx = bus.getContext(["a"]);
      expect(ctx).toContain("f1.ts, f2.ts, f3.ts");
    });

    it("lists multiple exports on separate lines", () => {
      const bus = new ManifestBus();
      bus.set(
        manifest("a", {
          exports: { Foo: "foo.ts:1", Bar: "bar.ts:2" },
        }),
      );
      const ctx = bus.getContext(["a"]);
      expect(ctx).toContain("Foo → foo.ts:1");
      expect(ctx).toContain("Bar → bar.ts:2");
    });

    it("throws when dependency manifest is missing", () => {
      const bus = new ManifestBus();
      expect(() => bus.getContext(["missing"])).toThrow(
        "Missing manifest for dependency agent: missing",
      );
    });

    it("throws for missing dep even when others exist", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a"));
      expect(() => bus.getContext(["a", "b"])).toThrow(
        "Missing manifest for dependency agent: b",
      );
    });
  });

  // ── snapshot ──────────────────────────────────────────────

  describe("snapshot", () => {
    it("returns empty snapshot when bus has no manifests", () => {
      const bus = new ManifestBus();
      const snap = bus.snapshot();
      expect(snap.manifests).toEqual([]);
      expect(snap.contextForNext).toBe("You run first — no upstream context.");
    });

    it("returns all manifests and full context after storing", () => {
      const bus = new ManifestBus();
      bus.set(manifest("researcher", { summary: "Found evidence for X" }));
      bus.set(manifest("product-owner", { summary: "Prioritized feature Y" }));

      const snap = bus.snapshot();
      expect(snap.manifests).toHaveLength(2);
      expect(snap.manifests[0].agent).toBe("researcher");
      expect(snap.manifests[1].agent).toBe("product-owner");
      expect(snap.contextForNext).toContain("[researcher]");
      expect(snap.contextForNext).toContain("Found evidence for X");
      expect(snap.contextForNext).toContain("[product-owner]");
      expect(snap.contextForNext).toContain("Prioritized feature Y");
    });

    it("snapshot grows as more manifests are added", () => {
      const bus = new ManifestBus();

      bus.set(manifest("a", { summary: "A output" }));
      const snap1 = bus.snapshot();
      expect(snap1.manifests).toHaveLength(1);
      expect(snap1.contextForNext).toContain("[a]");
      expect(snap1.contextForNext).not.toContain("[b]");

      bus.set(manifest("b", { summary: "B output" }));
      const snap2 = bus.snapshot();
      expect(snap2.manifests).toHaveLength(2);
      expect(snap2.contextForNext).toContain("[a]");
      expect(snap2.contextForNext).toContain("[b]");

      bus.set(manifest("c", { summary: "C output" }));
      const snap3 = bus.snapshot();
      expect(snap3.manifests).toHaveLength(3);
      expect(snap3.contextForNext).toContain("[a]");
      expect(snap3.contextForNext).toContain("[b]");
      expect(snap3.contextForNext).toContain("[c]");
    });
  });

  // ── getFullContext ───────────────────────────────────────

  describe("getFullContext", () => {
    it("returns no-upstream message when bus is empty", () => {
      const bus = new ManifestBus();
      expect(bus.getFullContext()).toBe("You run first — no upstream context.");
    });

    it("returns context from all stored manifests", () => {
      const bus = new ManifestBus();
      bus.set(manifest("researcher", { summary: "Found X" }));
      bus.set(manifest("product-owner", { summary: "Prioritized Y" }));

      const ctx = bus.getFullContext();
      expect(ctx).toContain("[researcher]");
      expect(ctx).toContain("Found X");
      expect(ctx).toContain("[product-owner]");
      expect(ctx).toContain("Prioritized Y");
    });

    it("includes all manifests regardless of dependsOn wiring", () => {
      const bus = new ManifestBus();
      bus.set(manifest("a", { summary: "A output" }));
      bus.set(manifest("b", { summary: "B output" }));
      bus.set(manifest("c", { summary: "C output" }));

      const ctx = bus.getFullContext();
      expect(ctx).toContain("[a]");
      expect(ctx).toContain("[b]");
      expect(ctx).toContain("[c]");
    });
  });
});
