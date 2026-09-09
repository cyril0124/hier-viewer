import { groupNodeGeometry } from './schematic-model.js';
import type { ScenePort, SchematicNet, SchematicScene } from './schematic-types.js';
import { OrthogonalRouter } from './schematic-routing.js';

type Displacement = { id: string; before: { x: number; y: number }; after: { x: number; y: number } };
const expansionHistory = new WeakMap<SchematicScene, Map<string, Displacement[]>>();

/**
 * Resize one group synchronously and reroute only its affected topology.
 * The group grows around its center. Automatically displaced neighbors are
 * restored when it collapses if the user has not moved them since expansion.
 */
export function setGroupExpanded(
  scene: SchematicScene,
  router: OrthogonalRouter,
  groupId: string,
  expanded: boolean,
  netById: ReadonlyMap<string, SchematicNet>,
): { nodeIds: string[]; edgeIds: string[] } {
  const group = scene.nodes.find(node => node.id === groupId && node.kind === 'group');
  const definition = scene.groups.find(candidate => candidate.id === groupId);
  if (!group || !definition) throw new Error(`Cannot expand missing group ${groupId}`);

  const geometry = groupNodeGeometry(definition, expanded, netById);
  const rowsByNet = new Map(geometry.rows?.map(row => [row.netId, row]));
  const ports: ScenePort[] = group.ports.map(port => {
    let netId: string;
    try {
      [netId] = JSON.parse(port.id) as [string, number];
    } catch {
      throw new Error(`Invalid group port ${port.id}`);
    }
    const row = rowsByNet.get(netId);
    const y = row?.y ?? geometry.height / 2;
    return { ...port, x: port.side === 'WEST' ? 0 : geometry.width, y };
  });

  const expandedHeight = geometry.height - group.height;
  const centeredY = expanded ? Math.max(0, group.y - expandedHeight / 2) : group.y;
  const changed = router.resizeNode(groupId, { ...geometry, x: group.x, y: centeredY, ports });
  let sceneHistory = expansionHistory.get(scene);
  if (!sceneHistory) {
    sceneHistory = new Map();
    expansionHistory.set(scene, sceneHistory);
  }
  if (expanded) {
    const displacements = changed.nodeIds
      .filter(id => id !== groupId)
      .map(id => {
        const before = changed.previousBoxes.get(id)!;
        const node = scene.nodes.find(candidate => candidate.id === id)!;
        return { id, before: { x: before.x, y: before.y }, after: { x: node.x, y: node.y } };
      });
    sceneHistory.set(groupId, displacements);
  } else {
    const displacements = sceneHistory.get(groupId) ?? [];
    sceneHistory.delete(groupId);
    const centerX = group.x + geometry.width / 2;
    const centerY = group.y + geometry.height / 2;
    displacements.sort((a, b) => {
      const nodeA = scene.nodes.find(node => node.id === a.id)!;
      const nodeB = scene.nodes.find(node => node.id === b.id)!;
      return Math.hypot(nodeA.x + nodeA.width / 2 - centerX, nodeA.y + nodeA.height / 2 - centerY)
        - Math.hypot(nodeB.x + nodeB.width / 2 - centerX, nodeB.y + nodeB.height / 2 - centerY);
    });
    for (const displacement of displacements) {
      const node = scene.nodes.find(candidate => candidate.id === displacement.id);
      if (!node || node.x !== displacement.after.x || node.y !== displacement.after.y) continue;
      const restored = router.moveNode(displacement.id, displacement.before.x, displacement.before.y);
      changed.nodeIds.push(...restored.nodeIds);
      changed.edgeIds.push(...restored.edgeIds);
    }
    changed.nodeIds = [...new Set(changed.nodeIds)];
    changed.edgeIds = [...new Set(changed.edgeIds)];
  }
  group.rows = geometry.rows;
  group.expanded = expanded;
  return changed;
}
