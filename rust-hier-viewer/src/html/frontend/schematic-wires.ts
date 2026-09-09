import type { SceneEdge, SchematicScene } from './schematic-types.js';

export interface VisibleWire {
  edge: SceneEdge;
  edgeIds: string[];
  netIds: string[];
}

/** Coalesce coincident paths only between the same nodes and with the same status.
 * All physical edges stay in the scene. Expanding a group separates its row paths,
 * so those signals become individually selectable without losing net identities.
 */
export function visibleWires(scene: SchematicScene): VisibleWire[] {
  const nodeById = new Map(scene.nodes.map(node => [node.id, node]));
  const groupByNet = new Map<string, string>();
  for (const group of scene.groups) for (const netId of group.netIds) groupByNet.set(netId, group.id);
  const wires = new Map<string, VisibleWire>();
  for (const edge of scene.edges) {
    const sourceNode = nodeById.get(edge.source.nodeId);
    const targetNode = nodeById.get(edge.target.nodeId);
    const groupId = edge.netIds.map(netId => groupByNet.get(netId)).find(Boolean) ?? '';
    const collapsedBus = (sourceNode?.kind === 'group' && !sourceNode.expanded)
      || (targetNode?.kind === 'group' && !targetNode.expanded);
    const pathKey = collapsedBus
      ? JSON.stringify([edge.source.nodeId, edge.target.nodeId, edge.status, groupId])
      : JSON.stringify([edge.source.nodeId, edge.target.nodeId, edge.status, edge.points]);
    const existing = wires.get(pathKey);
    if (existing) {
      existing.edgeIds.push(edge.id);
      existing.netIds.push(...edge.netIds);
    } else {
      wires.set(pathKey, { edge, edgeIds: [edge.id], netIds: [...edge.netIds] });
    }
  }
  for (const wire of wires.values()) wire.netIds = [...new Set(wire.netIds)];
  return [...wires.values()];
}
