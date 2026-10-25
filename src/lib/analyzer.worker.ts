import { analyzeProject } from "./analyzer";
import type { KnowledgeGraph, SourceFileInput } from "./types";

interface AnalyzeRequest {
  files: SourceFileInput[];
}

type AnalyzeResponse = { graph: KnowledgeGraph } | { error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse): void;
};

workerScope.onmessage = (event) => {
  try {
    workerScope.postMessage({ graph: analyzeProject(event.data.files) });
  } catch (cause) {
    workerScope.postMessage({ error: cause instanceof Error ? cause.message : "Source analysis failed" });
  }
};
