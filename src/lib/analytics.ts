import type { GraphEdge, KnowledgeGraph } from "./types";

export interface GraphAnalytics {
  degree: Map<string, number>;
  rank: Map<string, number>;
  community: Map<string, number>;
  cycle: Map<string, number>;
  godNodes: string[];
}

interface GraphIndex {
  ids: string[];
  byId: Map<string, number>;
  degree: Map<string, number>;
  neighbors: number[][];
  relations: number[][];
  outgoing: number[][];
  incident: GraphEdge[][];
}

const INDEX_CACHE = new WeakMap<KnowledgeGraph, GraphIndex>();

function graphIndex(graph: KnowledgeGraph): GraphIndex {
  const cached = INDEX_CACHE.get(graph);
  if (cached) return cached;
  const ids = graph.nodes.map((node) => node.id).sort();
  const byId = new Map(ids.map((id, index) => [id, index]));
  const degree = new Map(ids.map((id) => [id, 0]));
  const neighborSets = ids.map(() => new Set<number>());
  const relationSets = ids.map(() => new Set<number>());
  const outgoingSets = ids.map(() => new Set<number>());
  const incident: GraphEdge[][] = ids.map(() => []);
  for (const edge of graph.edges) {
    // Public degree retains the former behavior: every endpoint and repeated edge counts.
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    incident[source].push(edge);
    if (target !== source) incident[target].push(edge);
    if (target === source) continue;
    neighborSets[source].add(target);
    neighborSets[target].add(source);
    if (edge.type === "contains") continue;
    relationSets[source].add(target);
    relationSets[target].add(source);
    outgoingSets[source].add(target);
  }
  const flatten = (sets: Set<number>[]) => sets.map((set) => [...set].sort((a, b) => a - b));
  const index: GraphIndex = {
    ids,
    byId,
    degree,
    neighbors: flatten(neighborSets),
    relations: flatten(relationSets),
    outgoing: flatten(outgoingSets),
    incident,
  };
  INDEX_CACHE.set(graph, index);
  return index;
}

function pageRank(index: GraphIndex): Map<string, number> {
  const { ids, outgoing } = index;
  const size = ids.length;
  const rank = new Map<string, number>();
  if (size === 0) return rank;
  const scores = new Float64Array(size).fill(1 / size);
  if (!outgoing.some((targets) => targets.length > 0)) {
    ids.forEach((id) => rank.set(id, 1 / size));
    return rank;
  }
  const next = new Float64Array(size);
  const damping = 0.85;
  for (let pass = 0; pass < 30; pass++) {
    let dangling = 0;
    for (let node = 0; node < size; node++) if (outgoing[node].length === 0) dangling += scores[node];
    const base = (1 - damping) / size + damping * dangling / size;
    next.fill(base);
    for (let node = 0; node < size; node++) {
      const targets = outgoing[node];
      if (targets.length === 0) continue;
      const share = damping * scores[node] / targets.length;
      for (const target of targets) next[target] += share;
    }
    let delta = 0;
    for (let node = 0; node < size; node++) {
      delta += Math.abs(next[node] - scores[node]);
      scores[node] = next[node];
    }
    if (delta < 1e-6) break;
  }
  let total = 0;
  for (const score of scores) total += score;
  ids.forEach((id, node) => rank.set(id, total > 0 ? scores[node] / total : 1 / size));
  return rank;
}

function stronglyConnected(index: GraphIndex): string[][] {
  const { ids, outgoing } = index;
  const size = ids.length;
  const discovery = new Int32Array(size).fill(-1);
  const low = new Int32Array(size);
  const onStack = new Uint8Array(size);
  const stack: number[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (let start = 0; start < size; start++) {
    if (discovery[start] !== -1) continue;
    discovery[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = 1;
    const frames: { node: number; edge: number }[] = [{ node: start, edge: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.edge < outgoing[frame.node].length) {
        const next = outgoing[frame.node][frame.edge++];
        if (discovery[next] === -1) {
          discovery[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          frames.push({ node: next, edge: 0 });
        } else if (onStack[next]) {
          low[frame.node] = Math.min(low[frame.node], discovery[next]);
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].node;
        low[parent] = Math.min(low[parent], low[frame.node]);
      }
      if (low[frame.node] !== discovery[frame.node]) continue;
      const component: string[] = [];
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = 0;
        component.push(ids[member]);
      } while (member !== frame.node);
      if (component.length > 1) components.push(component.sort());
    }
  }
  return components.sort((a, b) => a[0].localeCompare(b[0]));
}

export function computeAnalytics(graph: KnowledgeGraph): GraphAnalytics {
  const index = graphIndex(graph);
  const { ids, relations } = index;
  const rank = pageRank(index);

  // Peripheral-first visits limit bridge merging; retaining tied labels prevents oscillation.
  const labels = ids.map((_, node) => node);
  const order = labels.slice().sort((a, b) => relations[a].length - relations[b].length || a - b);
  for (let pass = 0; pass < 24; pass++) {
    let changes = 0;
    for (const node of order) {
      const votes = new Map<number, number>();
      for (const neighbor of relations[node]) {
        const label = labels[neighbor];
        votes.set(label, (votes.get(label) ?? 0) + 1);
      }
      const current = labels[node];
      let best = current;
      let bestCount = votes.get(current) ?? 0;
      for (const [label, count] of votes) {
        if (count > bestCount || (count === bestCount && best !== current && label < best)) {
          best = label;
          bestCount = count;
        }
      }
      if (best !== current) {
        labels[node] = best;
        changes++;
      }
    }
    if (changes === 0) break;
  }
  const dense = new Map<number, number>();
  const community = new Map<string, number>();
  ids.forEach((id, node) => {
    if (!dense.has(labels[node])) dense.set(labels[node], dense.size);
    community.set(id, dense.get(labels[node])!);
  });

  const cycle = new Map<string, number>();
  for (const component of stronglyConnected(index)) {
    for (const id of component) cycle.set(id, component.length);
  }

  const godNodes = ids
    .filter((id) => (index.degree.get(id) ?? 0) > 0)
    .sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0)
      || (index.degree.get(b) ?? 0) - (index.degree.get(a) ?? 0)
      || a.localeCompare(b))
    .slice(0, 5);
  return { degree: index.degree, rank, community, cycle, godNodes };
}

export function neighborhood(graph: KnowledgeGraph, ids: Iterable<string>, depth = 1): Set<string> {
  const index = graphIndex(graph);
  const selected = new Set(ids);
  let frontier = [...selected]
    .map((id) => index.byId.get(id))
    .filter((node): node is number => node !== undefined);
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const node of frontier) {
      for (const neighbor of index.neighbors[node]) {
        const id = index.ids[neighbor];
        if (selected.has(id)) continue;
        selected.add(id);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return selected;
}

export function impactSet(graph: KnowledgeGraph, ids: Iterable<string>): Set<string> {
  const affected = new Set(ids);
  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type === "contains") continue;
    const sources = dependents.get(edge.target) ?? [];
    sources.push(edge.source);
    dependents.set(edge.target, sources);
  }
  let frontier = [...affected];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of dependents.get(id) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        next.push(dependent);
      }
    }
    frontier = next;
  }
  return affected;
}

export function shortestPath(graph: KnowledgeGraph, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const index = graphIndex(graph);
  const start = index.byId.get(from);
  const goal = index.byId.get(to);
  if (start === undefined || goal === undefined) return null;
  const fromParents = new Map<number, number>([[start, -1]]);
  const toParents = new Map<number, number>([[goal, -1]]);
  const fromDepth = new Map<number, number>([[start, 0]]);
  const toDepth = new Map<number, number>([[goal, 0]]);
  let forward = [start];
  let backward = [goal];
  let forwardDepth = 0;
  let backwardDepth = 0;
  let best: { node: number; length: number } | null = null;
  const reconstruct = (meet: number): string[] => {
    const left: number[] = [];
    for (let node = meet; node !== -1; node = fromParents.get(node)!) left.push(node);
    left.reverse();
    for (let node = toParents.get(meet) ?? -1; node !== -1; node = toParents.get(node)!) left.push(node);
    return left.map((node) => index.ids[node]);
  };
  // Expanding the smaller frontier keeps work balanced, but the best path is only final
  // once both searches reach its length; otherwise an early meet can be a detour.
  while (forward.length > 0 && backward.length > 0 && (!best || forwardDepth + backwardDepth < best.length)) {
    const expandForward = forward.length <= backward.length;
    const frontier = expandForward ? forward : backward;
    const own = expandForward ? fromParents : toParents;
    const other = expandForward ? toParents : fromParents;
    const ownDepth = expandForward ? fromDepth : toDepth;
    const otherDepth = expandForward ? toDepth : fromDepth;
    if (expandForward) forwardDepth++;
    else backwardDepth++;
    const next: number[] = [];
    for (const node of frontier) {
      for (const neighbor of index.neighbors[node]) {
        if (!own.has(neighbor)) {
          own.set(neighbor, node);
          ownDepth.set(neighbor, ownDepth.get(node)! + 1);
          next.push(neighbor);
        }
        if (!other.has(neighbor)) continue;
        const length = ownDepth.get(neighbor)! + otherDepth.get(neighbor)!;
        if (!best || length < best.length) best = { node: neighbor, length };
      }
    }
    if (expandForward) forward = next;
    else backward = next;
  }
  return best ? reconstruct(best.node) : null;
}

export interface Connection {
  edge: GraphEdge;
  other: string;
  direction: "outgoing" | "incoming";
}

export function explainNode(graph: KnowledgeGraph, id: string): Connection[] {
  const index = graphIndex(graph);
  const node = index.byId.get(id);
  if (node === undefined) return [];
  const connections = index.incident[node].map((edge): Connection => edge.source === id
    ? { edge, other: edge.target, direction: "outgoing" }
    : { edge, other: edge.source, direction: "incoming" });
  return connections.sort((a, b) => a.edge.type.localeCompare(b.edge.type) || a.other.localeCompare(b.other));
}
