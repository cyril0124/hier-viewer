import { summarizeLogic } from './schematic-summary.js';
import type {
  LinkGroup, SceneEdge, SceneNode, ScenePort, SchematicEndpoint, SchematicGraph,
  SchematicNet, SchematicNode, SchematicScene,
} from './schematic-types.js';

export const PORT_SPACING = 24;
const HEADER_HEIGHT = 48;
const EXPANDED_GROUP_ROW_SPACING = 16;
const MAX_BIT_WIDTH_PADDING = 112;

export function bitWidthPadding(width: number): number {
  if (!Number.isFinite(width) || width <= 1) return 0;
  return Math.min(MAX_BIT_WIDTH_PADDING, Math.round(Math.log2(width) * 10));
}

const MAX_MODULE_SCALE = 2;

/**
 * Normalize weighted signal bits within one scope. Logarithmic input keeps a
 * very large memory from overwhelming the comparison; square-root output
 * gives medium-sized modules useful separation.
 */
export function metricSizeScale(weight: number | undefined, minimumWeight: number, maximumWeight: number): number {
  if (!Number.isFinite(weight) || weight === undefined || maximumWeight <= minimumWeight) return 1;
  const low = Math.log1p(Math.max(0, minimumWeight));
  const high = Math.log1p(Math.max(0, maximumWeight));
  const normalized = Math.max(0, Math.min(1, (Math.log1p(Math.max(0, weight)) - low) / (high - low)));
  return 1 + Math.sqrt(normalized) * (MAX_MODULE_SCALE - 1);
}

/** Compact captions never replace the complete RTL names kept in details. */
export function compactLabel(label: string, length = 32): string {
  return label.length > length ? `${label.slice(0, length - 1)}…` : label;
}

/** Recover the useful expression caption stored in a node detail. */
export function expressionLabel(node: { kind: string; label: string; detail: string }): string {
  if (node.kind !== 'expr' && node.kind !== 'constant' && node.kind !== 'unresolved') return node.label;
  const unsupportedPrefix = 'Unsupported semantic expression: ';
  const detail = node.detail.startsWith(unsupportedPrefix)
    ? node.detail.slice(unsupportedPrefix.length)
    : node.detail;
  const separator = detail.indexOf(': ');
  if (separator < 0) return node.label;
  const expression = detail.slice(separator + 2);
  const valueSeparator = expression.indexOf(' = ');
  return valueSeparator < 0 ? expression : expression.slice(0, valueSeparator);
}

/** Use the source expression for display while keeping the database net name short. */
export function displayNetName(
  net: SchematicNet,
  nodes: ReadonlyMap<string, { kind: string; label: string; detail: string }>,
): string {
  if (net.name !== 'value') return net.name;
  for (const endpoint of net.endpoints) {
    if (net.id !== `${endpoint.nodeId}:value`) continue;
    const node = nodes.get(endpoint.nodeId);
    if (node && (node.kind === 'expr' || node.kind === 'constant' || node.kind === 'unresolved')) return expressionLabel(node);
  }
  return net.name;
}

/** Conservative monospace metrics also work in workers without a canvas. */
export function labelWidth(label: string): number {
  let width = 0;
  for (const character of label) width += character.codePointAt(0)! > 255 ? 14 : 7;
  return width;
}

function nameTokens(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_.\s/\[\]:-]+/).filter(Boolean);
}

/** Names select presentation groups only; endpoint identities always come from the graph. */
export function findLinkGroups(nets: readonly SchematicNet[]): LinkGroup[] {
  const candidates = new Map<string, { label: string; netIds: string[]; depth: number }>();
  const endpointSets = new Map<string, SchematicNet[]>();
  for (const net of nets) {
    const endpoints = JSON.stringify([...new Set(net.endpoints.map(endpoint => JSON.stringify([endpoint.nodeId, endpoint.role])))].sort());
    const shared = endpointSets.get(endpoints);
    if (shared) shared.push(net);
    else endpointSets.set(endpoints, [net]);
  }
  // Most expression nets have unique endpoints. They cannot form a group, so
  // do not build every textual prefix of potentially very long RTL expressions.
  for (const [nodes, sharedNets] of endpointSets) {
    if (sharedNets.length < 2) continue;
    for (const net of sharedNets) {
      const tokens = nameTokens(net.name);
      for (let depth = 1; depth < tokens.length; depth++) {
        const label = tokens.slice(0, depth).join('_');
        const key = JSON.stringify([nodes, label]);
        let candidate = candidates.get(key);
        if (!candidate) {
          candidate = { label, netIds: [], depth };
          candidates.set(key, candidate);
        }
        candidate.netIds.push(net.id);
      }
    }
  }
  const assigned = new Set<string>();
  const groups: LinkGroup[] = [];
  // Prefer the interface prefix covering the most signals. Choosing the deepest
  // field prefixes first fragments wide RTL interfaces into hundreds of tiny boxes.
  const ordered = [...candidates.entries()].sort((a, b) =>
    b[1].netIds.length - a[1].netIds.length || b[1].depth - a[1].depth || a[0].localeCompare(b[0]));
  for (const [key, candidate] of ordered) {
    const netIds = candidate.netIds.filter(id => !assigned.has(id)).sort();
    if (netIds.length < 2) continue;
    groups.push({ id: `group:${key}`, label: candidate.label, netIds });
    for (const id of netIds) assigned.add(id);
  }
  // Scalar constants and generated names may have no useful textual prefix.
  // Large sets still form an interface when their actual owners and roles agree.
  for (const [endpoints, sharedNets] of endpointSets) {
    const remaining = sharedNets.filter(net => !assigned.has(net.id));
    if (remaining.length < 8) continue;
    groups.push({
      id: `group:signals:${endpoints}`, label: 'Signals',
      netIds: remaining.map(net => net.id).sort(),
    });
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}

function moduleNode(
  node: SchematicNode,
  groupByPort: ReadonlyMap<string, LinkGroup | null>,
  minimumWeight: number,
  maximumWeight: number,
): SceneNode {
  const expressionLike = node.kind === 'expr' || node.kind === 'constant' || node.kind === 'unresolved';
  const caption = expressionLike ? node.label.replace(/\s+/g, ' ').trim() : node.label;
  const label = expressionLike ? compactLabel(caption, 36) : caption;
  const detail = label !== node.label && !node.detail.includes(node.label) ? `${node.detail}\n${node.label}` : node.detail;
  const ports: ScenePort[] = [...node.ports]
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .map(port => ({
      id: port.id,
      label: port.name,
      direction: port.direction,
      width: port.width,
      side: (node.kind === 'boundary' ? port.direction === 'input' : port.direction === 'output') ? 'EAST' : 'WEST',
      hidden: !groupByPort.has(port.id),
      x: 0,
      y: HEADER_HEIGHT + PORT_SPACING / 2,
    }));

  // Only pins that belong to the same actual net group and side share a terminal.
  // Every physical ID is retained for routing, signal inspection and exact expansion.
  const terminals = new Map<string, ScenePort[]>();
  for (const port of ports) {
    if (port.hidden) continue;
    const group = groupByPort.get(port.id);
    const key = JSON.stringify([port.side, group?.id ?? port.id]);
    const members = terminals.get(key);
    if (members) members.push(port);
    else terminals.set(key, [port]);
  }
  for (const members of terminals.values()) {
    const first = members[0];
    if (members.length > 1) {
      const tokenSets = members.map(port => nameTokens(port.label));
      // Stop at the first differing token; matching later tokens are unrelated fields.
      let length = 0;
      while (length < tokenSets[0].length && tokenSets.every(tokens => tokens[length] === tokenSets[0][length])) length++;
      const name = length ? tokenSets[0].slice(0, length).join('_') : groupByPort.get(first.id)!.label;
      first.displayLabel = `${compactLabel(name, 26)} · ${members.length}`;
      first.bundleCount = members.length;
      for (const port of members.slice(1)) port.hidden = true;
    } else {
      first.displayLabel = compactLabel(first.width > 1 ? `${first.label} [${first.width}]` : first.label);
    }
  }
  const west = [...terminals.values()].filter(members => members[0].side === 'WEST');
  const east = [...terminals.values()].filter(members => members[0].side === 'EAST');
  const terminalWidth = (members: ScenePort[]): number => labelWidth(members[0].displayLabel || '');
  const westWidth = Math.max(0, ...west.map(terminalWidth));
  const eastWidth = Math.max(0, ...east.map(terminalWidth));
  const widestPort = Math.max(1, ...ports.map(port => port.width));
  const baseWidth = Math.max(144, labelWidth(label) + 32, westWidth + eastWidth + 48)
    + bitWidthPadding(widestPort);
  const baseHeight = HEADER_HEIGHT + Math.max(1, west.length, east.length) * PORT_SPACING + 12
    + Math.min(36, Math.round(bitWidthPadding(widestPort) * 0.32));
  const metricScale = metricSizeScale(node.visualWeight, minimumWeight, maximumWeight);
  const width = Math.round(baseWidth * metricScale);
  const height = Math.round(baseHeight * Math.sqrt(metricScale));
  for (const sideTerminals of [west, east]) {
    sideTerminals.forEach((members, index) => {
      for (const port of members) port.y = HEADER_HEIGHT + (index + 0.5) * PORT_SPACING;
    });
  }
  for (const port of ports) port.x = port.side === 'WEST' ? 0 : width;
  const subtitle = terminals.size < ports.length
    ? `${terminals.size} terminals · ${ports.length} pins`
    : `${ports.length} ${ports.length === 1 ? 'pin' : 'pins'}`;
  return { ...node, label, detail, subtitle, ports, x: 0, y: 0, width, height };
}

/** Shared by initial scene construction and synchronous group expansion. */
export function groupNodeGeometry(
  group: LinkGroup,
  expanded: boolean,
  netById: ReadonlyMap<string, SchematicNet>,
): Pick<SceneNode, 'width' | 'height' | 'rows' | 'expanded'> {
  const rows: NonNullable<SceneNode['rows']> = [];
  let width = Math.max(96, labelWidth(compactLabel(group.label)) + 64);
  if (expanded) {
    for (const [index, netId] of group.netIds.entries()) {
      const net = netById.get(netId);
      if (!net) throw new Error(`Group ${group.id} references missing net ${netId}`);
      const label = net.width > 1 ? `${net.name} [${net.width}]` : net.name;
      rows.push({ netId, label, y: HEADER_HEIGHT + (index + 0.5) * EXPANDED_GROUP_ROW_SPACING });
      width = Math.max(width, labelWidth(label) + 32);
    }
  }
  const widestNet = Math.max(1, ...group.netIds.map(id => netById.get(id)?.width ?? 0));
  width += bitWidthPadding(widestNet);
  return {
    width,
    height: expanded ? HEADER_HEIGHT + group.netIds.length * EXPANDED_GROUP_ROW_SPACING + 12 : 36,
    rows,
    expanded,
  };
}

/** Place the scope's driving inputs and receiving outputs on opposite edges.
 * The exported graph stays unchanged; only the visual owner of output pins changes.
 */
function splitBoundary(graph: SchematicGraph): SchematicGraph {
  const nodes: SchematicNode[] = [];
  const outputOwners = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.kind !== 'boundary') {
      nodes.push(node);
      continue;
    }
    const inputs = node.ports.filter(port => port.direction === 'input');
    const outputs = node.ports.filter(port => port.direction !== 'input');
    if (!inputs.length || !outputs.length) {
      nodes.push({ ...node, label: inputs.length ? 'Inputs' : 'Outputs' });
      continue;
    }
    nodes.push({ ...node, label: 'Inputs', ports: inputs });
    nodes.push({ ...node, id: `${node.id}:outputs`, label: 'Outputs', ports: outputs });
    outputOwners.set(node.id, new Set(outputs.map(port => port.id)));
  }
  if (!outputOwners.size) return { ...graph, nodes };
  const nets = graph.nets.map(net => ({
    ...net,
    endpoints: net.endpoints.map(endpoint => outputOwners.get(endpoint.nodeId)?.has(endpoint.portId)
      ? { ...endpoint, nodeId: `${endpoint.nodeId}:outputs` }
      : endpoint),
  }));
  return { ...graph, nodes, nets };
}

/** Build topology and dimensions. layoutScene assigns initial positions and routes the edges. */
export function buildScene(rawGraph: SchematicGraph, expanded: ReadonlySet<string>, detail = false): SchematicScene {
  const summary = detail ? { graph: rawGraph, hiddenNodes: 0, hiddenNets: 0 } : summarizeLogic(rawGraph);
  const graph = splitBoundary(summary.graph);
  const graphNodes = new Map(graph.nodes.map(node => [node.id, node]));
  // Expression net names are reconstructed from their endpoint node in memory.
  // The exported database stores only "value" instead of another full copy.
  const nets = graph.nets
    .map(net => ({ ...net, name: displayNetName(net, graphNodes) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const netById = new Map(nets.map(net => [net.id, net]));
  const groups = findLinkGroups(nets);
  const definitionByNet = new Map(groups.flatMap(group => group.netIds.map(id => [id, group] as const)));
  const groupsByNode = new Map<string, Map<string, LinkGroup | null>>();
  for (const node of graph.nodes) {
    if (!node.id.endsWith(':logic:body')) continue;
    const compactGroup: LinkGroup = { id: 'group:local-logic', label: 'Local logic', netIds: [] };
    groupsByNode.set(node.id, new Map(node.ports.map(port => [port.id, compactGroup])));
  }
  for (const net of nets) {
    for (const endpoint of net.endpoints) {
      if (endpoint.nodeId.endsWith(':logic:body')) continue;
      let byPort = groupsByNode.get(endpoint.nodeId);
      if (!byPort) {
        byPort = new Map();
        groupsByNode.set(endpoint.nodeId, byPort);
      }
      const group = definitionByNet.get(net.id) ?? null;
      // A shared physical pin may carry nets from different groups. Keep that
      // pin individually visible instead of assigning it to an arbitrary bus.
      if (byPort.has(endpoint.portId) && byPort.get(endpoint.portId) !== group) byPort.set(endpoint.portId, null);
      else byPort.set(endpoint.portId, group);
    }
  }
  const weightedModuleWeights = graph.nodes
    .filter(node => node.kind === 'module' && Number.isFinite(node.visualWeight) && node.visualWeight! > 0)
    .map(node => node.visualWeight!);
  const minimumWeight = weightedModuleWeights.length ? Math.min(...weightedModuleWeights) : 0;
  const maximumWeight = weightedModuleWeights.length ? Math.max(...weightedModuleWeights) : 0;
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))
    .map(node => moduleNode(node, groupsByNode.get(node.id) ?? new Map(), minimumWeight, maximumWeight));
  const portByNode = new Map(nodes.map(node => [node.id, new Map(node.ports.map(port => [port.id, port]))]));
  const groupByNet = new Map<string, SceneNode>();
  const edges: SceneEdge[] = [];

  for (const group of groups) {
    const groupNode: SceneNode = {
      id: group.id, groupId: group.id, kind: 'group', label: group.label,
      detail: `${group.netIds.length} signals`, instancePath: null,
      x: 0, y: 0, ports: [],
      ...groupNodeGeometry(group, expanded.has(group.id), netById),
    };
    nodes.push(groupNode);
    for (const id of group.netIds) groupByNet.set(id, groupNode);
  }

  function endpointPort(endpoint: SchematicEndpoint): ScenePort {
    const port = portByNode.get(endpoint.nodeId)?.get(endpoint.portId);
    if (!port) throw new Error(`Net references missing port ${endpoint.nodeId}/${endpoint.portId}`);
    return port;
  }

  function addEdge(net: SchematicNet, source: SceneEdge['source'], target: SceneEdge['target'], suffix: string): void {
    edges.push({ id: `edge:${JSON.stringify([net.id, suffix])}`, netIds: [net.id], label: net.name, status: net.status, source, target, points: [] });
  }

  for (const net of nets) {
    const seen = new Set<string>();
    const endpoints = net.endpoints.filter(endpoint => {
      endpointPort(endpoint);
      const key = JSON.stringify([endpoint.nodeId, endpoint.portId]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (endpoints.length === 0) continue;
    const drivers = endpoints.filter(endpoint => endpoint.role === 'driver');
    let hub = groupByNet.get(net.id);
    if (!hub && net.status === 'resolved' && drivers.length === 1 && endpoints.length > 1) {
      for (const endpoint of endpoints) {
        if (endpoint === drivers[0]) continue;
        addEdge(net, drivers[0], endpoint, JSON.stringify([endpoint.nodeId, endpoint.portId]));
      }
      continue;
    }
    if (!hub) {
      const label = net.status === 'resolved' ? net.name : `${net.name} (${net.status})`;
      hub = {
        id: `junction:${net.id}`, kind: 'junction', label, detail: net.status,
        instancePath: null, x: 0, y: 0, width: Math.max(48, labelWidth(label) + 24) + bitWidthPadding(net.width),
        height: 32 + Math.min(12, Math.round(bitWidthPadding(net.width) * 0.25)), ports: [],
      };
      nodes.push(hub);
    }
    const row = hub.rows?.find(item => item.netId === net.id);
    for (const [index, endpoint] of endpoints.entries()) {
      const endpointSide = endpointPort(endpoint).side;
      const portId = JSON.stringify([net.id, index]);
      const side = endpointSide === 'EAST' ? 'WEST' : 'EAST';
      hub.ports.push({
        id: portId, label: '', side, direction: 'unknown', width: net.width,
        x: side === 'WEST' ? 0 : hub.width, y: row?.y ?? hub.height / 2,
      });
      const hubEndpoint = { nodeId: hub.id, portId };
      if (endpoint.role === 'driver') addEdge(net, endpoint, hubEndpoint, String(index));
      else addEdge(net, hubEndpoint, endpoint, String(index));
    }
  }

  // Keep even the pre-layout scene collision-free for callers inspecting its topology.
  let y = 32;
  for (const node of nodes) {
    node.x = 32;
    node.y = y;
    y += node.height + 48;
  }
  return {
    nodes, edges, groups, width: Math.max(0, ...nodes.map(node => node.width + 64)), height: y,
    ...(summary.hiddenNodes ? { summary: { nodes: summary.hiddenNodes, nets: summary.hiddenNets } } : {}),
  };
}
