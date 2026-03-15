import type { AgentDefinition } from "../types.js";

export interface DependencyGraph {
  waves: AgentDefinition[][];
}

function findCyclePath(
  remaining: Set<string>,
  depsByAgent: Map<string, string[]>,
): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    visiting.add(node);
    stack.push(node);

    const deps = depsByAgent.get(node) ?? [];
    for (const dep of deps) {
      if (!remaining.has(dep)) continue;

      if (visiting.has(dep)) {
        const cycleStart = stack.indexOf(dep);
        const cycle = stack.slice(cycleStart);
        cycle.push(dep);
        return cycle;
      }

      if (!visited.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of remaining) {
    if (visited.has(node)) continue;
    const cycle = dfs(node);
    if (cycle) return cycle;
  }

  return [];
}

export function buildDependencyGraph(agents: AgentDefinition[]): DependencyGraph {
  const byName = new Map<string, AgentDefinition>();

  for (const agent of agents) {
    if (byName.has(agent.name)) {
      throw new Error(`Duplicate agent name: ${agent.name}`);
    }
    byName.set(agent.name, agent);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const depsByAgent = new Map<string, string[]>();

  for (const agent of agents) {
    const deps = Array.from(new Set(agent.dependsOn ?? []));
    depsByAgent.set(agent.name, deps);

    for (const dep of deps) {
      if (!byName.has(dep)) {
        throw new Error(`Unknown dependency "${dep}" referenced by agent "${agent.name}"`);
      }
    }

    inDegree.set(agent.name, deps.length);

    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(agent.name);
      dependents.set(dep, list);
    }
  }

  let frontier = agents.filter((a) => (inDegree.get(a.name) ?? 0) === 0).map((a) => a.name);
  const waves: AgentDefinition[][] = [];
  let processed = 0;

  while (frontier.length > 0) {
    const waveNames = frontier;
    frontier = [];

    const wave: AgentDefinition[] = [];
    for (const name of waveNames) {
      const agent = byName.get(name);
      if (!agent) continue;
      wave.push(agent);
      processed += 1;

      for (const dependent of dependents.get(name) ?? []) {
        const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          frontier.push(dependent);
        }
      }
    }

    waves.push(wave);
  }

  if (processed !== agents.length) {
    const remaining = new Set<string>();
    for (const [name, degree] of inDegree.entries()) {
      if (degree > 0) remaining.add(name);
    }

    const cycle = findCyclePath(remaining, depsByAgent);
    const rendered = cycle.length > 0 ? cycle.join(" → ") : Array.from(remaining).join(" → ");
    throw new Error(`Cycle detected in agent dependency graph: ${rendered}`);
  }

  return { waves };
}
