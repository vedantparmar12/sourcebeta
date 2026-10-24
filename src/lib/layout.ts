import type { GraphAnalytics } from "./analytics";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./types";

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  radius: number;
  fixed: boolean;
}
export interface GraphLayout {
  nodes: LayoutNode[];
  edges: { from: LayoutNode; to: LayoutNode; edge: GraphEdge }[];
}
export interface GraphCamera { x: number; y: number; scale: number }

export function createLayout(graph: KnowledgeGraph, analytics: GraphAnalytics): GraphLayout {
  const groups = new Map<number, GraphNode[]>();
  for (const node of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const community = analytics.community.get(node.id) ?? -1;
    const group = groups.get(community) ?? [];
    group.push(node);
    groups.set(community, group);
  }
  const blocks = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .map(([, nodes]) => ({ nodes, size: 48 * Math.sqrt(nodes.length) + 40 }));
  const shelfWidth = Math.max(blocks[0]?.size ?? 0, Math.sqrt(blocks.reduce((area, block) => area + block.size ** 2, 0)) * 1.2);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const nodes: LayoutNode[] = [];
  for (const block of blocks) {
    if (x + block.size > shelfWidth && x > 0) { x = 0; y += rowHeight; rowHeight = 0; }
    const anchorX = x + block.size / 2;
    const anchorY = y + block.size / 2;
    block.nodes.forEach((node, index) => {
      const angle = index * 2.399963229728653;
      const distance = 23 * Math.sqrt(index);
      nodes.push({ ...node, x: anchorX + Math.cos(angle) * distance, y: anchorY + Math.sin(angle) * distance,
        vx: 0, vy: 0, anchorX, anchorY, radius: Math.min(20, 3 + Math.sqrt(analytics.degree.get(node.id) ?? 0) * 1.6), fixed: false });
    });
    x += block.size;
    rowHeight = Math.max(rowHeight, block.size);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphLayout["edges"] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (from && to) edges.push({ from, to, edge });
  }
  return { nodes, edges };
}

export function stepLayout(layout: GraphLayout, heat: number): number {
  const cells = new Map<string, LayoutNode[]>();
  for (const node of layout.nodes) {
    const key = `${Math.floor(node.x / 100)},${Math.floor(node.y / 100)}`;
    const cell = cells.get(key) ?? [];
    cell.push(node);
    cells.set(key, cell);
    node.vx += (node.anchorX - node.x) * 0.001 * heat;
    node.vy += (node.anchorY - node.y) * 0.001 * heat;
  }
  for (let index = 0; index < layout.nodes.length; index++) {
    const node = layout.nodes[index];
    const cx = Math.floor(node.x / 100);
    const cy = Math.floor(node.y / 100);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const cell = cells.get(`${x},${y}`);
        if (!cell) continue;
        // Sampling caps work even if thousands of nodes occupy the same cell.
        const count = Math.min(cell.length, 12);
        for (let sample = 0; sample < count; sample++) {
          const other = cell[(Math.floor(sample * cell.length / count) + index) % cell.length];
          if (other === node) continue;
          let dx = node.x - other.x;
          let dy = node.y - other.y;
          if (dx === 0 && dy === 0) { dx = Math.cos(index * 2.4); dy = Math.sin(index * 2.4); }
          const distance = Math.max(1, Math.hypot(dx, dy));
          const clearance = node.radius + other.radius + 14;
          const force = (Math.min(1.8, 160 / (distance * distance)) + Math.max(0, clearance - distance) * 0.035) * heat;
          node.vx += dx / distance * force;
          node.vy += dy / distance * force;
        }
      }
    }
  }
  for (const { from, to, edge } of layout.edges) {
    if (from === to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const desired = (edge.type === "contains" ? 55 : 90) + from.radius + to.radius;
    const force = Math.max(-3, Math.min(3, (distance - desired) * 0.012)) * heat;
    const fx = dx / distance * force;
    const fy = dy / distance * force;
    from.vx += fx / Math.sqrt(from.radius);
    from.vy += fy / Math.sqrt(from.radius);
    to.vx -= fx / Math.sqrt(to.radius);
    to.vy -= fy / Math.sqrt(to.radius);
  }
  let movement = 0;
  for (const node of layout.nodes) {
    if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
    node.vx *= 0.72;
    node.vy *= 0.72;
    const speed = Math.hypot(node.vx, node.vy);
    if (speed > 8) { node.vx *= 8 / speed; node.vy *= 8 / speed; }
    node.x += node.vx;
    node.y += node.vy;
    movement += Math.abs(node.vx) + Math.abs(node.vy);
  }
  return movement / Math.max(1, layout.nodes.length);
}

export function fitGraph(nodes: LayoutNode[], width: number, height: number): GraphCamera {
  if (nodes.length === 0) return { x: width / 2, y: height / 2, scale: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  const scale = Math.max(0.01, Math.min(1.6, Math.max(1, width - 140) / Math.max(1, maxX - minX), Math.max(1, height - 120) / Math.max(1, maxY - minY)));
  return { scale, x: width / 2 - (minX + maxX) / 2 * scale, y: height / 2 - (minY + maxY) / 2 * scale };
}

export function hitGraphNode(nodes: LayoutNode[], visibleIds: Set<string>, camera: GraphCamera, x: number, y: number): LayoutNode | undefined {
  const wx = (x - camera.x) / camera.scale;
  const wy = (y - camera.y) / camera.scale;
  let nearest: LayoutNode | undefined;
  let closest = Infinity;
  for (const node of nodes) {
    if (!visibleIds.has(node.id)) continue;
    const distance = Math.hypot(node.x - wx, node.y - wy);
    if (distance <= Math.max(node.radius + 3, 8 / camera.scale) && distance < closest) { nearest = node; closest = distance; }
  }
  return nearest;
}
