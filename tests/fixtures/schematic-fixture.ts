import type { SchematicGraph, SchematicNode } from '../../rust-hier-viewer/src/html/frontend/schematic-types';

/** Endpoint identities and naming groups deliberately remain separate fixture fields. */
export function twoModules(count = 8, longNames = false): SchematicGraph {
  const names = Array.from({ length: count }, (_, index) => `${index < count / 2 ? 'request' : 'response'}_field${index}`);
  return {
    version: 1, scopePath: 'top',
    nodes: ['producer', 'consumer'].map((id, nodeIndex) => ({
      id, kind: 'module', label: longNames ? `${id}_with_a_long_parameterized_instance_name_that_must_fit` : id,
      instancePath: `top.${id}`, detail: 'Parameterized RTL module',
      ports: names.map((name, ordinal) => ({
        id: `p${ordinal}`, name: longNames ? `long_port_${name}` : name,
        direction: nodeIndex === 0 ? 'output' : 'input', width: ordinal % 3 ? 32 : 1, ordinal,
      })),
    })),
    nets: names.map((name, index) => ({
      id: `n${index}`, name, width: index % 3 ? 32 : 1, status: 'resolved',
      endpoints: [{ nodeId: 'producer', portId: `p${index}`, role: 'driver' }, { nodeId: 'consumer', portId: `p${index}`, role: 'sink' }],
    })),
  };
}

/** Many short connected chains exercise real expression placement without an artificial giant port. */
export function expressionGraph(count = 240): SchematicGraph {
  const graph = twoModules();
  graph.scopePath = 'top.expressions';
  for (let index = 0; index < count; index++) {
    const node: SchematicNode = {
      id: `expr${index}`, kind: 'expr', label: `expr ${index}`, instancePath: null,
      detail: `operand[${index % 32}] ^ enable`,
      ports: [
        { id: 'in', name: 'operand', direction: 'input', width: 1, ordinal: 0 },
        { id: 'out', name: 'result', direction: 'output', width: 1, ordinal: 1 },
      ],
    };
    graph.nodes.push(node);
    if (index % 8 !== 0) graph.nets.push({
      id: `dep${index}`, name: `dependency${index}`, width: 1, status: 'resolved',
      endpoints: [{ nodeId: `expr${index - 1}`, portId: 'out', role: 'driver' }, { nodeId: node.id, portId: 'in', role: 'sink' }],
    });
  }
  return graph;
}

export function emptyGraph(scopePath = 'top.empty'): SchematicGraph {
  return { version: 1, scopePath, nodes: [], nets: [] };
}
