import type { SchematicGraph, SchematicNode } from './schematic-types.js';

/** Represent a module's local RTL body as a box beside its child instances.
 * Every external net remains separate. Internal connections are retained in the
 * untouched raw graph for RTL detail; the summary never represents a net short.
 */
export function summarizeLogic(graph: SchematicGraph): { graph: SchematicGraph; hiddenNodes: number; hiddenNets: number } {
  const internal = graph.nodes.filter(node => node.kind === 'expr' || node.kind === 'constant'
    || (node.kind === 'unresolved' && !node.id.endsWith(':elaboration-errors')));
  const unchanged = { graph, hiddenNodes: 0, hiddenNets: 0 };
  if (internal.length <= 16 || graph.nodes.length <= 32) return unchanged;
  const internalIds = new Set(internal.map(node => node.id));
  const modules = new Set(graph.nodes.filter(node => node.kind === 'module').map(node => node.id));
  const hasBoundary = graph.nodes.some(node => node.kind === 'boundary');
  const touchesModule = graph.nets.some(net => net.endpoints.some(endpoint => internalIds.has(endpoint.nodeId))
    && net.endpoints.some(endpoint => modules.has(endpoint.nodeId)));
  if (!modules.size || (!hasBoundary && !touchesModule)) return unchanged;

  const unresolvedCount = internal.filter(node => node.kind === 'unresolved').length;
  const internalIssues = graph.nets.filter(net => net.status !== 'resolved' && net.endpoints.length > 0
    && net.endpoints.every(endpoint => internalIds.has(endpoint.nodeId))).length;
  const issueCount = unresolvedCount + internalIssues;
  const summary: SchematicNode = {
    id: `${graph.scopePath}:logic:body`, kind: issueCount ? 'unresolved' : 'module',
    label: `Local logic · ${internal.length}${issueCount ? ` · ${issueCount} issues` : ''}`,
    instancePath: null, ports: [],
    detail: `${internal.length.toLocaleString('en-US')} RTL expression, constant and diagnostic nodes in this module. ${unresolvedCount} unresolved nodes and ${internalIssues} internal nets with unresolved, bidirectional or multi-driver status. Enable RTL detail to inspect their complete logic. Each terminal retains a separate net; this box does not short its inputs and outputs.`,
  };
  const nodes = graph.nodes.filter(node => !internalIds.has(node.id));
  nodes.push(summary);
  const nets: SchematicGraph['nets'] = [];
  let hiddenNets = 0;
  for (const net of graph.nets) {
    const internalOnly = net.endpoints.length > 0 && net.endpoints.every(endpoint => internalIds.has(endpoint.nodeId));
    if (internalOnly) {
      hiddenNets++;
      continue;
    }
    const seen = new Set<string>();
    const endpoints: typeof net.endpoints = [];
    for (const endpoint of net.endpoints) {
      if (!internalIds.has(endpoint.nodeId)) {
        endpoints.push(endpoint);
        continue;
      }
      // One terminal per original net and endpoint role, including ambiguous nets.
      const id = JSON.stringify([net.id, endpoint.role]);
      if (seen.has(id)) continue;
      seen.add(id);
      summary.ports.push({
        id, name: net.name, width: net.width, ordinal: summary.ports.length,
        direction: endpoint.role === 'driver' ? 'output' : endpoint.role === 'sink' ? 'input' : 'inout',
      });
      endpoints.push({ ...endpoint, nodeId: summary.id, portId: id });
    }
    nets.push({ ...net, endpoints });
  }
  return { graph: { ...graph, nodes, nets }, hiddenNodes: internal.length, hiddenNets };
}
