import { useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView";
import { CanvasView } from "./components/CanvasView";
import { SourceView } from "./components/SourceView";
import { computeAnalytics, explainNode, neighborhood, shortestPath } from "./lib/analytics";
import { sceneBounds, selectionToElements, type BoardElement } from "./lib/canvas";
import { DEMO_FILES } from "./lib/demo";
import { pickProjectFromDirectory, readProjectFromInput, supportsDirectoryPicker, type ProjectScan } from "./lib/loadFiles";
import { MAX_FILES, MAX_FILE_BYTES } from "./lib/scan";
import type { KnowledgeGraph, NodeKind, SourceFileInput } from "./lib/types";
import "./App.css";

const ALL_KINDS: NodeKind[] = ["file", "function", "class", "note"];
const NO_FILES = "No supported files found. sourcebeta reads JS/TS, Python, Java, Rust, Go, C/C++, and Markdown files.";
const PATH_FILTER_THRESHOLD = 500;
const PATH_OPTION_LIMIT = 40;
const EMPTY_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };
const PROJECT_QUERY = new URLSearchParams(window.location.search).has("project");

function scanNotice(scan: ProjectScan): string {
  const notes: string[] = [];
  if (scan.truncated) notes.push(`Partial scan: stopped at ${MAX_FILES.toLocaleString()} files; additional supported files were omitted.`);
  if (scan.skippedLarge > 0) notes.push(`Skipped ${scan.skippedLarge} file${scan.skippedLarge === 1 ? "" : "s"} larger than ${MAX_FILE_BYTES / 1_000_000} MB.`);
  if (scan.skippedUnreadable > 0) notes.push(`Skipped ${scan.skippedUnreadable} unreadable file${scan.skippedUnreadable === 1 ? "" : "s"}; the graph is incomplete.`);
  return notes.join(" ");
}

function analysisNotice(graph: KnowledgeGraph): string {
  const warnings = graph.warnings ?? [];
  if (!warnings.length) return "";
  const paths = warnings.slice(0, 3).join(", ");
  const remainder = warnings.length > 3 ? ` and ${warnings.length - 3} more` : "";
  return `Partial analysis: ${warnings.length} file${warnings.length === 1 ? "" : "s"} could not be analyzed (${paths}${remainder}). File nodes remain, but their symbols and edges are missing.`;
}

export default function App() {
  const [analyzedGraph, setAnalyzedGraph] = useState<KnowledgeGraph | null>(null);
  const [view, setView] = useState<"graph" | "canvas">("graph");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<NodeKind>>(new Set(ALL_KINDS));
  const [community, setCommunity] = useState("all");
  const [localOnly, setLocalOnly] = useState(false);
  const [depth, setDepth] = useState(1);
  const [pathTarget, setPathTarget] = useState("");
  const [pathQuery, setPathQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(PROJECT_QUERY ? "Loading project graph…" : "Loading demo graph…");
  const [projectGraph, setProjectGraph] = useState<KnowledgeGraph | null>(null);
  const [projectName, setProjectName] = useState("");

  const [scene, setScene] = useState<BoardElement[]>([]);
  const [fitKey, setFitKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const graphRequest = useRef(0);
  const analysisWorker = useRef<Worker | null>(null);
  const scanController = useRef<AbortController | null>(null);

  const graph = projectGraph ?? analyzedGraph ?? EMPTY_GRAPH;
  const analytics = useMemo(() => computeAnalytics(graph), [graph]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const communities = useMemo(
    () => [...new Set(analytics.community.values())].sort((a, b) => a - b),
    [analytics],
  );

  const visibleIds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let ids = new Set(
      graph.nodes
        .filter((node) => kinds.has(node.kind))
        .filter((node) => community === "all" || analytics.community.get(node.id) === Number(community))
        .filter((node) => !needle || node.label.toLowerCase().includes(needle) || node.file.toLowerCase().includes(needle))
        .map((node) => node.id),
    );
    if (localOnly && selected.size > 0) {
      const near = neighborhood(graph, selected, depth);
      ids = new Set([...ids].filter((id) => near.has(id)));
    }
    return ids;
  }, [graph, kinds, community, query, analytics, localOnly, selected, depth]);

  const activeNode = activeId ? nodeById.get(activeId) : undefined;
  const activeStartLine = activeNode?.startLine ?? activeNode?.line;
  const connections = useMemo(
    () => activeId ? explainNode(graph, activeId) : [],
    [graph, activeId],
  );
  const path = useMemo(
    () => activeId && pathTarget ? shortestPath(graph, activeId, pathTarget) : null,
    [graph, activeId, pathTarget],
  );
  const pathCandidates = useMemo(() => {
    if (!activeNode) return { options: [], total: 0 };
    const needle = pathQuery.trim().toLowerCase();
    const matches = graph.nodes
      .filter((node) => node.id !== activeNode.id && (!needle || `${node.label} ${node.file}`.toLowerCase().includes(needle)))
      .sort((a, b) => (analytics.degree.get(b.id) ?? 0) - (analytics.degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    return {
      options: matches.slice(0, graph.nodes.length > PATH_FILTER_THRESHOLD ? PATH_OPTION_LIMIT : matches.length),
      total: matches.length,
    };
  }, [graph, activeNode, pathQuery, analytics]);

  const cancelWork = () => {
    graphRequest.current += 1;
    scanController.current?.abort();
    scanController.current = null;
    analysisWorker.current?.terminate();
    analysisWorker.current = null;
    setBusy("");
  };

  useEffect(() => {
    if (!PROJECT_QUERY) {
      loadFiles(DEMO_FILES);
      return () => {
        graphRequest.current += 1;
        analysisWorker.current?.terminate();
      };
    }
    const request = ++graphRequest.current;
    const controller = new AbortController();
    scanController.current = controller;
    fetch("/api/sourcebeta/project", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<{ name: string; graph: KnowledgeGraph }>;
      })
      .then((project) => {
        if (request !== graphRequest.current) return;
        setProjectName(project.name);
        setProjectGraph(project.graph);
        setNotice(analysisNotice(project.graph));
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError" && request === graphRequest.current) setError(`Could not load project graph: ${cause.message}`);
      })
      .finally(() => {
        if (scanController.current === controller) scanController.current = null;
        if (request === graphRequest.current) setBusy("");
      });
    return () => controller.abort();
  }, []);

  const selectNode = (id: string, additive: boolean) => {
    setActiveId(id);
    setSelected((previous) => {
      if (!additive) return new Set([id]);
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function loadFiles(next: SourceFileInput[]) {
    cancelWork();
    const request = graphRequest.current;
    setAnalyzedGraph(null);
    setProjectGraph(null);
    setProjectName("");
    setSelected(new Set());
    setActiveId(null);
    setPathTarget("");
    setPathQuery("");
    setQuery("");
    setLocalOnly(false);
    setError("");
    setNotice("");
    setBusy("Analyzing source files…");
    try {
      const worker = new Worker(new URL("./lib/analyzer.worker.ts", import.meta.url), { type: "module" });
      analysisWorker.current = worker;
      const finish = () => {
        worker.terminate();
        if (analysisWorker.current === worker) analysisWorker.current = null;
      };
      worker.onmessage = (event: MessageEvent<{ graph: KnowledgeGraph } | { error: string }>) => {
        if (request === graphRequest.current) {
          if ("error" in event.data) setError(`Could not analyze source files: ${event.data.error}`);
          else {
            setAnalyzedGraph(event.data.graph);
            const warning = analysisNotice(event.data.graph);
            if (warning) setNotice((previous) => [previous, warning].filter(Boolean).join(" "));
          }
          setBusy("");
        }
        finish();
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        if (request === graphRequest.current) {
          setError(`Could not analyze source files: ${event.message || "the analyzer worker failed"}`);
          setBusy("");
        }
        finish();
      };
      worker.postMessage({ files: next });
    } catch (cause) {
      if (request === graphRequest.current) {
        setError(`Could not start source analysis: ${(cause as Error).message}`);
        setBusy("");
      }
    }
  }

  const openFolder = async () => {
    cancelWork();
    const request = graphRequest.current;
    const controller = new AbortController();
    scanController.current = controller;
    setError("");
    setNotice("");
    try {
      if (!supportsDirectoryPicker()) {
        inputRef.current?.click();
        return;
      }
      const scan = await pickProjectFromDirectory(controller.signal);
      if (!scan || request !== graphRequest.current) return;
      if (scan.files.length === 0) {
        setError(NO_FILES);
        return;
      }
      loadFiles(scan.files);
      setNotice(scanNotice(scan));
    } catch (cause) {
      if ((cause as Error).name !== "AbortError" && request === graphRequest.current) setError((cause as Error).message);
    } finally {
      if (scanController.current === controller) scanController.current = null;
    }
  };

  const sendToCanvas = () => {
    if (selected.size === 0) return;
    const bounds = sceneBounds(scene);
    const elements = selectionToElements(graph, selected, scene.length ? bounds.y + bounds.height + 100 : 0);
    setScene([...scene, ...elements]);
    setFitKey((value) => value + 1);
    setView("canvas");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          source<span>beta</span>
          <small>{projectName || "code knowledge graph + whiteboard"}</small>
        </div>
        <button onClick={openFolder}>Open folder</button>
        <button onClick={() => loadFiles(DEMO_FILES)}>Demo project</button>
        {busy && <button onClick={cancelWork}>Cancel</button>}
        <nav className="tabs">
          <button className={view === "graph" ? "tab active" : "tab"} onClick={() => setView("graph")}>Graph</button>
          <button className={view === "canvas" ? "tab active" : "tab"} onClick={() => setView("canvas")}>Canvas</button>
        </nav>
        <span className="stats">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
      </header>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        {...{ webkitdirectory: "" }}
        onChange={async (event) => {
          const list = event.target.files;
          if (list && list.length > 0) {
            cancelWork();
            const request = graphRequest.current;
            const controller = new AbortController();
            scanController.current = controller;
            setError("");
            setNotice("");
            try {
              const scan = await readProjectFromInput(list, controller.signal);
              if (request !== graphRequest.current) return;
              if (scan.files.length === 0) setError(NO_FILES);
              else {
                loadFiles(scan.files);
                setNotice(scanNotice(scan));
              }
            } catch (cause) {
              if ((cause as Error).name !== "AbortError" && request === graphRequest.current) setError((cause as Error).message);
            } finally {
              if (scanController.current === controller) scanController.current = null;
            }
          }
          event.target.value = "";
        }}
      />
      {error && <div role="alert" className="error">{error}</div>}
      {notice && <div role="status" className="notice">{notice}</div>}

      {view === "graph" ? (
        <div className="workspace">
          <aside className="panel controls">
            <label className="field">
              Search
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="name or path" />
            </label>
            <div className="field">
              Show
              {ALL_KINDS.map((kind) => (
                <label key={kind} className="check">
                  <input
                    type="checkbox"
                    checked={kinds.has(kind)}
                    onChange={() => {
                      const next = new Set(kinds);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      setKinds(next);
                    }}
                  />
                  {kind === "class" ? "classes" : `${kind}s`}
                </label>
              ))}
            </div>
            <label className="field">
              Community
              <select aria-label="Community" value={community} onChange={(event) => setCommunity(event.target.value)}>
                <option value="all">All communities</option>
                {communities.map((id) => <option key={id} value={id}>Community {id}</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={localOnly} onChange={(event) => setLocalOnly(event.target.checked)} />
              Local graph around selection
            </label>
            {localOnly && (
              <label className="field">
                Depth
                <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                  <option value={1}>1 hop</option>
                  <option value={2}>2 hops</option>
                </select>
              </label>
            )}
            <hr />
            <p className="hint">Click selects · Ctrl/⌘-click multi-selects · drag to move · scroll to zoom</p>
            <button onClick={() => selected.size > 0 && setSelected(neighborhood(graph, selected, 1))} disabled={selected.size === 0}>
              Select neighbors
            </button>
            <button onClick={() => { setSelected(new Set()); setActiveId(null); }} disabled={selected.size === 0}>
              Clear selection
            </button>
            <button className="primary" onClick={sendToCanvas} disabled={selected.size === 0}>
              Send {selected.size || ""} node{selected.size === 1 ? "" : "s"} to canvas
            </button>
            <p className="hint">Solid edges are EXTRACTED from source; dashed edges are INFERRED by name resolution.</p>
          </aside>

          <main className="stage">
            {busy ? <p role="status" className="empty">{busy}</p> : visibleIds.size === 0 ? <p className="empty">No nodes match these filters.</p> : null}
            <GraphView
              graph={graph}
              analytics={analytics}
              visibleIds={visibleIds}
              selected={selected}
              activeId={activeId}
              onSelect={selectNode}
              onBackground={() => setActiveId(null)}
            />
          </main>

          <aside className="panel details">
            {activeNode ? (
              <>
                <h2>{activeNode.label}</h2>
                <p className="meta">
                  {activeNode.kind} · {activeNode.file}{activeStartLine ? `:${activeStartLine}` : ""}
                  {activeStartLine && activeNode.endLine && activeNode.endLine !== activeStartLine ? `–${activeNode.endLine}` : ""}
                </p>
                <p className="meta">
                  degree {analytics.degree.get(activeNode.id) ?? 0} · PageRank {(analytics.rank.get(activeNode.id) ?? 0).toFixed(3)}
                  {analytics.community.has(activeNode.id) ? ` · community ${analytics.community.get(activeNode.id)}` : ""}
                  {analytics.cycle.has(activeNode.id) ? ` · ${analytics.cycle.get(activeNode.id)}-node cycle` : ""}
                  {analytics.godNodes.includes(activeNode.id) ? " · key node" : ""}
                </p>
                <button onClick={() => setSelected(neighborhood(graph, [activeNode.id], 1))}>Select neighborhood</button>
                <SourceView key={activeId} node={activeNode} source={graph.sources?.[activeNode.file]} />
                <h3>Connections ({connections.length})</h3>
                <ul className="connections">
                  {connections.map((connection, index) => (
                    <li key={`${connection.edge.source}-${connection.edge.target}-${index}`}>
                      <button onClick={() => selectNode(connection.other, false)}>
                        <span className="direction">{connection.direction === "outgoing" ? "→" : "←"}</span>
                        {nodeById.get(connection.other)?.label ?? connection.other}
                        <em>{connection.edge.type} · {connection.edge.confidence}</em>
                      </button>
                    </li>
                  ))}
                </ul>
                <h3>Shortest path</h3>
                {graph.nodes.length > PATH_FILTER_THRESHOLD && (
                  <label className="field">
                    Filter targets
                    <input
                      value={pathQuery}
                      onChange={(event) => setPathQuery(event.target.value)}
                      placeholder="target name or path"
                    />
                  </label>
                )}
                <select value={pathTarget} onChange={(event) => setPathTarget(event.target.value)}>
                  <option value="">Choose a target…</option>
                  {pathTarget && nodeById.has(pathTarget) && !pathCandidates.options.some((node) => node.id === pathTarget) && (
                    <option value={pathTarget}>{nodeById.get(pathTarget)!.label} ({nodeById.get(pathTarget)!.file})</option>
                  )}
                  {pathCandidates.options.map((node) => (
                    <option key={node.id} value={node.id}>{node.label} ({node.file})</option>
                  ))}
                </select>
                {graph.nodes.length > PATH_FILTER_THRESHOLD && (
                  <p className="hint">
                    {pathQuery.trim()
                      ? `${pathCandidates.total} match${pathCandidates.total === 1 ? "" : "es"}`
                      : `Showing ${pathCandidates.options.length} of ${pathCandidates.total} targets. Type to search.`}
                  </p>
                )}
                {pathTarget && (path ? (
                  <ol className="path">
                    {path.map((id) => <li key={id}>{nodeById.get(id)?.label ?? id}</li>)}
                  </ol>
                ) : <p className="hint">No path connects these nodes.</p>)}
              </>
            ) : (
              <>
                <p className="hint">Select a node to inspect its connections, community and paths.</p>
                <h3>Key nodes</h3>
                <ul className="connections">
                  {analytics.godNodes.map((id) => (
                    <li key={id}>
                      <button onClick={() => selectNode(id, false)}>
                        {nodeById.get(id)?.label ?? id}
                        <em>PageRank {(analytics.rank.get(id) ?? 0).toFixed(3)} · degree {analytics.degree.get(id) ?? 0}</em>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      ) : (
        <div className="canvas-workspace">
          <div className="canvas-toolbar">
            <button className="primary" onClick={sendToCanvas} disabled={selected.size === 0}>
              Add {selected.size || ""} selected node{selected.size === 1 ? "" : "s"}
            </button>
            <span className="hint">Draw, connect and annotate your code architecture.</span>
          </div>
          <CanvasView elements={scene} onChange={setScene} fitKey={fitKey} />
        </div>
      )}
    </div>
  );
}
