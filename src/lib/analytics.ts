import type { GraphEdge, KnowledgeGraph } from "./types";

export interface GraphAnalytics {
  degree: Map<string, number>;
  community: Map<string, number>;
  godNodes: string[];
}

export function computeAnalytics(graph: KnowledgeGraph): GraphAnalytics {
  const degree = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
  const ids = [...degree.keys()].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = ids.map(() => new Set<number>());
  for (const edge of graph.edges) {
    // Public degree counts every endpoint, including contains and repeated edges.
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (edge.source === edge.target || edge.type === "contains") continue;
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    adjacency[source].add(target);
    adjacency[target].add(source);
  }

  // Peripheral-first visits limit bridge merging; retaining tied labels prevents oscillation.
  const labels = ids.map((_, i) => i);
  const order = labels.slice().sort((a, b) => adjacency[a].size - adjacency[b].size || a - b);
  for (let pass = 0; pass < 24; pass++) {
    let changes = 0;
    for (const node of order) {
      const votes = new Map<number, number>();
      for (const neighbor of adjacency[node]) {
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
  ids.forEach((id, i) => {
    if (!dense.has(labels[i])) dense.set(labels[i], dense.size);
    community.set(id, dense.get(labels[i])!);
  });
  const godNodes = [...degree.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
  return { degree, community, godNodes };
}

export function neighborhood(graph: KnowledgeGraph, ids: Iterable<string>, depth = 1): Set<string> {
  const selected = new Set(ids);
  let frontier = new Set(selected);
  for (let step = 0; step < depth && frontier.size > 0; step++) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !selected.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !selected.has(edge.source)) next.add(edge.source);
    }
    for (const id of next) selected.add(id);
    frontier = next;
  }
  return selected;
}

export function shortestPath(graph: KnowledgeGraph, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const previous = new Map<string, string>([[from, ""]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacent(graph.edges, id)) {
        if (previous.has(neighbor)) continue;
        previous.set(neighbor, id);
        if (neighbor === to) {
          const path = [to];
          let cursor = id;
          while (cursor) {
            path.unshift(cursor);
            cursor = previous.get(cursor) ?? "";
          }
          return path;
        }
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return null;
}

function adjacent(edges: GraphEdge[], id: string): string[] {
  const result: string[] = [];
  for (const edge of edges) {
    if (edge.source === id) result.push(edge.target);
    if (edge.target === id) result.push(edge.source);
  }
  return result;
}

export interface Connection {
  edge: GraphEdge;
  other: string;
  direction: "outgoing" | "incoming";
}

export function explainNode(graph: KnowledgeGraph, id: string): Connection[] {
  const connections: Connection[] = [];
  for (const edge of graph.edges) {
    if (edge.source === id) connections.push({ edge, other: edge.target, direction: "outgoing" });
    else if (edge.target === id) connections.push({ edge, other: edge.source, direction: "incoming" });
  }
  return connections.sort((a, b) => a.edge.type.localeCompare(b.edge.type) || a.other.localeCompare(b.other));
}
