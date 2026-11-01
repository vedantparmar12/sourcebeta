import { arrowPoints, type BoardElement } from "./canvas";
import type { KnowledgeGraph, SourceFileInput } from "./types";

export interface SavedBoard {
  id: string;
  name: string;
  updatedAt: number;
  elements: BoardElement[];
}

const BOARD_KEY = "sourcebeta.boards.v1";

export function listSavedBoards(): SavedBoard[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(BOARD_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((board): board is SavedBoard => board && typeof board.id === "string" && typeof board.name === "string" && typeof board.updatedAt === "number" && Array.isArray(board.elements))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveBoard(board: SavedBoard): SavedBoard[] {
  const boards = [board, ...listSavedBoards().filter((item) => item.id !== board.id)];
  localStorage.setItem(BOARD_KEY, JSON.stringify(boards));
  return boards;
}

export function deleteBoard(id: string): SavedBoard[] {
  const boards = listSavedBoards().filter((board) => board.id !== id);
  localStorage.setItem(BOARD_KEY, JSON.stringify(boards));
  return boards;
}

export function changedProjectFiles(current: SourceFileInput[], baseline: SourceFileInput[]): Set<string> {
  const before = new Map(baseline.map((file) => [file.path, file.content]));
  const after = new Map(current.map((file) => [file.path, file.content]));
  const changed = new Set<string>();
  for (const [path, content] of after) if (before.get(path) !== content) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return changed;
}

function fuzzyIncludes(value: string, needle: string): boolean {
  if (value.includes(needle)) return true;
  if (needle.length > 5) return false;
  let index = 0;
  for (const character of value) if (character === needle[index]) index++;
  return index === needle.length;
}

export function matchesQuery(label: string, file: string, query: string): boolean {
  const value = `${label} ${file}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every((token) => fuzzyIncludes(value, token));
}

export function refreshBoardSources(elements: BoardElement[], graph: KnowledgeGraph): BoardElement[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return elements.map((element) => {
    if (!element.source) return element;
    const node = nodes.get(element.source.nodeId);
    if (!node) {
      const text = (element.text ?? "Missing node").replace(/\n\(source unavailable\)$/, "");
      return { ...element, text: `${text}\n(source unavailable)` };
    }
    return { ...element, text: `${node.label}\n${node.kind}`, source: { nodeId: node.id, file: node.file, ...(node.line != null ? { line: node.line } : {}) } };
  });
}

export function createBoardReport(name: string, elements: BoardElement[]): string {
  const reportElements = elements.map((element) => {
    if (element.kind !== "arrow") return element;
    const [from, to] = arrowPoints(element, elements);
    return { ...element, x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y, points: undefined, startId: undefined, endId: undefined };
  });
  const model = JSON.stringify({ name, elements: reportElements }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sourcebeta board</title><style>
html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#f5f6f8;color:#20242c}header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#fff;border-bottom:1px solid #ddd}h1{font-size:16px;margin:0 auto 0 0}button{font:inherit;padding:6px 10px}main{height:calc(100% - 53px);overflow:hidden}svg{width:100%;height:100%;background:#fff;touch-action:none}.hint{margin-left:8px;font-size:12px;color:#666}
</style></head><body><header><h1 id="name"></h1><button id="out">−</button><button id="in">+</button><button id="fit">Fit</button><span class="hint">Drag to pan · scroll to zoom</span></header><main><svg id="board" aria-label="Read-only Sourcebeta board"><g id="camera"></g></svg></main>
<script>const model=${model};
const NS="http://www.w3.org/2000/svg",board=document.getElementById("board"),camera=document.getElementById("camera");document.getElementById("name").textContent=model.name;
function node(tag,attrs,text){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs||{}))el.setAttribute(k,String(v));if(text!=null)el.textContent=text;return el}
function draw(parent,e){const g=node("g",{opacity:e.opacity??1});if(e.angle)g.setAttribute("transform","rotate("+(e.angle*180/Math.PI)+" "+(e.x+e.width/2)+" "+(e.y+e.height/2)+")");const paint={stroke:e.stroke,fill:e.fill,"stroke-width":e.strokeWidth,"stroke-dasharray":e.dashed?"6 4":"none"};let shape;
if(e.kind==="symbol"&&e.artwork){const inner=node("g",{transform:"translate("+e.x+" "+e.y+") scale("+(e.width/e.artwork.width)+" "+(e.height/e.artwork.height)+")"});for(const child of e.artwork.elements)draw(inner,child);shape=inner}
else if(e.kind==="ellipse")shape=node("ellipse",{...paint,cx:e.x+e.width/2,cy:e.y+e.height/2,rx:Math.abs(e.width/2),ry:Math.abs(e.height/2)});
else if(e.kind==="diamond")shape=node("polygon",{...paint,points:[[e.x+e.width/2,e.y],[e.x+e.width,e.y+e.height/2],[e.x+e.width/2,e.y+e.height],[e.x,e.y+e.height/2]].map(p=>p.join(",")).join(" ")});
else if(e.kind==="pen")shape=node("polyline",{...paint,fill:"none",points:(e.points||[]).map(p=>(e.x+p.x)+","+(e.y+p.y)).join(" ")});
else if(e.kind==="arrow"){const pts=e.points||[{x:0,y:0},{x:e.width,y:e.height}],a=pts[0],b=pts[pts.length-1];shape=node("line",{...paint,x1:e.x+a.x,y1:e.y+a.y,x2:e.x+b.x,y2:e.y+b.y,"marker-end":"url(#arrow)"})}
else if(e.kind!=="text")shape=node("rect",{...paint,x:e.x,y:e.y,width:e.width,height:e.height,rx:e.kind==="card"?12:3});if(shape)g.append(shape);
if(e.text){const lines=e.text.split("\\n");lines.forEach((line,i)=>{const centered=e.kind!=="text"&&e.kind!=="pen";g.append(node("text",{x:centered?e.x+e.width/2:e.x,y:centered?e.y+e.height/2+(i-(lines.length-1)/2)*22:e.y+(i+1)*(e.fontSize||20)*1.2,fill:e.kind==="card"?"#e9ecf2":e.kind==="container"?"#2c3040":e.stroke,"font-size":e.fontSize||20,"text-anchor":centered?"middle":"start","dominant-baseline":centered?"central":"auto"},line))})}if(e.comment)g.append(node("title",{},e.comment));parent.append(g)}
const defs=node("defs");const marker=node("marker",{id:"arrow",viewBox:"0 0 10 10",refX:9,refY:5,markerWidth:6,markerHeight:6,orient:"auto-start-reverse"});marker.append(node("path",{d:"M 0 0 L 10 5 L 0 10 z",fill:"#555"}));defs.append(marker);board.append(defs);for(const e of model.elements)draw(camera,e);
let view={x:0,y:0,k:1},bounds={x:0,y:0,w:800,h:500};if(model.elements.length){const boxes=model.elements.map(e=>({x:e.x,y:e.y,r:e.x+Math.abs(e.width),b:e.y+Math.abs(e.height)}));bounds={x:Math.min(...boxes.map(b=>b.x))-40,y:Math.min(...boxes.map(b=>b.y))-40,w:Math.max(...boxes.map(b=>b.r))-Math.min(...boxes.map(b=>b.x))+80,h:Math.max(...boxes.map(b=>b.b))-Math.min(...boxes.map(b=>b.y))+80}}
function apply(){camera.setAttribute("transform","translate("+view.x+" "+view.y+") scale("+view.k+")")}function fit(){const r=board.getBoundingClientRect();view.k=Math.max(.05,Math.min(2,Math.min(r.width/bounds.w,r.height/bounds.h)));view.x=(r.width-bounds.w*view.k)/2-bounds.x*view.k;view.y=(r.height-bounds.h*view.k)/2-bounds.y*view.k;apply()}function zoom(f){view.k=Math.max(.05,Math.min(8,view.k*f));apply()}document.getElementById("in").onclick=()=>zoom(1.25);document.getElementById("out").onclick=()=>zoom(.8);document.getElementById("fit").onclick=fit;
let drag=null;board.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};board.setPointerCapture(e.pointerId)};board.onpointermove=e=>{if(!drag)return;view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;apply()};board.onpointerup=()=>drag=null;board.onpointercancel=()=>drag=null;board.onwheel=e=>{e.preventDefault();zoom(Math.exp(-e.deltaY*.0015))};fit();
</script></body></html>`;
}
