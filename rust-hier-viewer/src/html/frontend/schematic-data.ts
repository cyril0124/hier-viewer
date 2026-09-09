import type { SchematicGraph, SchematicNode, SchematicNet } from "./schematic-types.js";

const kinds = new Set(["module", "boundary", "expr", "constant", "unresolved"]);
const directions = new Set(["input", "output", "inout", "ref", "unknown"]);
const statuses = new Set(["resolved", "multi-driver", "bidirectional", "unresolved"]);
const roles = new Set(["driver", "sink", "bidirectional", "unknown"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string"; }
function width(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function corrupt(detail: string): never { throw new Error(`Corrupt schematic data: ${detail}`); }

/** Validate external JSON before allocating geometry or starting the layout worker. */
export function parseSchematicGraph(raw: unknown): SchematicGraph {
  if (!record(raw) || raw.version !== 1 || !text(raw.scopePath) || !Array.isArray(raw.nodes) || !Array.isArray(raw.nets)) {
    corrupt("expected a version 1 scope with nodes and nets.");
  }
  const portsByNode = new Map<string, Set<string>>();
  for (const node of raw.nodes) {
    if (!record(node) || !text(node.id) || !text(node.label) || !text(node.detail)
      || !(node.instancePath === null || text(node.instancePath)) || !kinds.has(String(node.kind)) || !Array.isArray(node.ports)) {
      corrupt("invalid node.");
    }
    if (portsByNode.has(node.id)) corrupt(`duplicate node ${node.id}.`);
    const ports = new Set<string>();
    for (const port of node.ports) {
      if (!record(port) || !text(port.id) || !text(port.name) || !directions.has(String(port.direction))
        || !width(port.width) || !width(port.ordinal) || ports.has(port.id)) corrupt(`invalid port on ${node.id}.`);
      ports.add(port.id);
    }
    portsByNode.set(node.id, ports);
  }
  const netIds = new Set<string>();
  for (const net of raw.nets) {
    if (!record(net) || !text(net.id) || !text(net.name) || !width(net.width)
      || !statuses.has(String(net.status)) || !Array.isArray(net.endpoints) || netIds.has(net.id)) corrupt("invalid or duplicate net.");
    netIds.add(net.id);
    const endpoints = new Set<string>();
    for (const endpoint of net.endpoints) {
      if (!record(endpoint) || !text(endpoint.nodeId) || !text(endpoint.portId)
        || !roles.has(String(endpoint.role)) || !portsByNode.get(endpoint.nodeId)?.has(endpoint.portId)) {
        corrupt(`dangling or invalid endpoint on ${net.id}.`);
      }
      const key = JSON.stringify([endpoint.nodeId, endpoint.portId, endpoint.role]);
      if (endpoints.has(key)) corrupt(`duplicate endpoint on ${net.id}.`);
      endpoints.add(key);
    }
  }
  return { version: 1, scopePath: raw.scopePath, nodes: raw.nodes as SchematicNode[], nets: raw.nets as SchematicNet[] };
}

export async function loadSchematicGraph(url: string, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<SchematicGraph> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}. Regenerate the RTL bundle if a scope file is missing.`);
  const total = Number(response.headers.get("content-length")) || 0;
  progress(0, total);
  if (!response.body) return parseSchematicGraph(await response.json());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
    progress(received, total);
  }
  chunks.push(decoder.decode());
  signal.throwIfAborted();
  return parseSchematicGraph(JSON.parse(chunks.join("")));
}
