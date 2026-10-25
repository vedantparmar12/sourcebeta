export type NodeKind = "file" | "function" | "class" | "note";
export type EdgeKind = "imports" | "contains" | "calls" | "links";
export type EdgeConfidence = "EXTRACTED" | "INFERRED";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  file: string;
  line?: number;
  startLine?: number;
  endLine?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeKind;
  confidence: EdgeConfidence;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources?: Record<string, string>;
  warnings?: string[];
}

export interface SourceFileInput {
  path: string;
  content: string;
}
