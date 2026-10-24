import { useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "./components/GraphView";
import { CanvasView } from "./components/CanvasView";
import { analyzeProject } from "./lib/analyzer";
import { computeAnalytics, explainNode, neighborhood, shortestPath } from "./lib/analytics";
import { sceneBounds, selectionToElements, type BoardElement } from "./lib/canvas";
import { DEMO_FILES } from "./lib/demo";
import { pickProjectFromDirectory, readProjectFromInput, supportsDirectoryPicker } from "./lib/loadFiles";
import type { KnowledgeGraph, NodeKind, SourceFileInput } from "./lib/types";
import "./App.css";

const ALL_KINDS: NodeKind[] = ["file", "function", "class", "note"];

export default function App() {
  const [files, setFiles] = useState<SourceFileInput[]>(DEMO_FILES);
  const [view, setView] = useState<"graph" | "canvas">("graph");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<NodeKind>>(new Set(ALL_KINDS));
  const [community, setCommunity] = useState("all");
  const [localOnly, setLocalOnly] = useState(false);
  const [depth, setDepth] = useState(1);
  const [pathTarget, setPathTarget] = useState("");
  const [error, setError] = useState("");
  const [projectGraph, setProjectGraph] = useState<KnowledgeGraph | null>(null);
  const [projectName, setProjectName] = useState("");

  const [scene, setScene] = useState<BoardElement[]>([]);
  const [fitKey, setFitKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyzedGraph = useMemo(() => analyzeProject(files), [files]);
  const graph = projectGraph ?? analyzedGraph;
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
  const connections = useMemo(
    () => activeId ? explainNode(graph, activeId) : [],
    [graph, activeId],
  );
  const path = useMemo(
    () => activeId && pathTarget ? shortestPath(graph, activeId, pathTarget) : null,
    [graph, activeId, pathTarget],
  );

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("project")) return;
    let active = true;
    fetch("/api/sourcebeta/project")
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<{ name: string; graph: KnowledgeGraph }>;
      })
      .then((project) => {
        if (!active) return;
        setProjectName(project.name);
        setProjectGraph(project.graph);
      })
      .catch((cause: Error) => {
        if (active) setError(`Could not load project graph: ${cause.message}`);
      });
    return () => {
      active = false;
    };
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

  const loadFiles = (next: SourceFileInput[]) => {
    setFiles(next);
    setProjectGraph(null);
    setProjectName("");
    setSelected(new Set());
    setActiveId(null);
    setPathTarget("");
    setQuery("");
    setLocalOnly(false);
  };

  const openFolder = async () => {
    setError("");
    try {
      if (!supportsDirectoryPicker()) {
        inputRef.current?.click();
        return;
      }
      const picked = await pickProjectFromDirectory();
      if (picked && picked.length > 0) loadFiles(picked);
      else if (picked) setError("No supported files found. sourcebeta reads .ts, .js and .md files.");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
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
          if (list && list.length > 0) loadFiles(await readProjectFromInput(list));
          event.target.value = "";
        }}
      />
      {error && <div className="error">{error}</div>}

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
            {visibleIds.size === 0 ? <p className="empty">No nodes match these filters.</p> : null}
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
                <p className="meta">{activeNode.kind} · {activeNode.file}{activeNode.line ? `:${activeNode.line}` : ""}</p>
                <p className="meta">
                  degree {analytics.degree.get(activeNode.id) ?? 0}
                  {analytics.community.has(activeNode.id) ? ` · community ${analytics.community.get(activeNode.id)}` : ""}
                  {analytics.godNodes.includes(activeNode.id) ? " · god node" : ""}
                </p>
                <button onClick={() => setSelected(neighborhood(graph, [activeNode.id], 1))}>Select neighborhood</button>
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
                <select value={pathTarget} onChange={(event) => setPathTarget(event.target.value)}>
                  <option value="">Choose a target…</option>
                  {graph.nodes.filter((node) => node.id !== activeNode.id).map((node) => (
                    <option key={node.id} value={node.id}>{node.label} ({node.file})</option>
                  ))}
                </select>
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
                        <em>degree {analytics.degree.get(id) ?? 0}</em>
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
