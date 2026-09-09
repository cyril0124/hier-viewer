export type PortDirection = "input" | "output" | "inout" | "ref" | "unknown";
export type EndpointRole = "driver" | "sink" | "bidirectional" | "unknown";
export type NetStatus = "resolved" | "multi-driver" | "bidirectional" | "unresolved";
export interface SchematicPort {
  id: string;
  name: string;
  direction: PortDirection;
  width: number;
  ordinal: number;
}
export interface SchematicNode {
  id: string;
  kind: "module" | "boundary" | "expr" | "constant" | "unresolved";
  label: string;
  instancePath: string | null;
  detail: string;
  ports: SchematicPort[];
  /** Weighted signal bits from the hierarchy metric, used for visual sizing. */
  visualWeight?: number;
}
export interface SchematicEndpoint { nodeId: string; portId: string; role: EndpointRole }
export interface SchematicNet {
  id: string;
  name: string;
  width: number;
  status: NetStatus;
  endpoints: SchematicEndpoint[];
}
export interface SchematicGraph {
  version: 1;
  scopePath: string;
  nodes: SchematicNode[];
  nets: SchematicNet[];
}
export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface LinkGroup { id: string; label: string; netIds: string[] }
export interface ScenePort extends Point {
  id: string;
  label: string;
  side: "WEST" | "EAST";
  width: number;
  direction: PortDirection;
  /** Physical pins remain addressable when their interface shares a visible terminal. */
  hidden?: boolean;
  displayLabel?: string;
  bundleCount?: number;
}
export interface SceneNode extends Box {
  id: string;
  kind: SchematicNode["kind"] | "group" | "junction";
  label: string;
  detail: string;
  instancePath: string | null;
  visualWeight?: number;
  ports: ScenePort[];
  groupId?: string;
  expanded?: boolean;
  rows?: { netId: string; label: string; y: number }[];
  subtitle?: string;
}
export interface SceneEdge {
  id: string;
  netIds: string[];
  label: string;
  status: NetStatus;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  points: Point[];
}
export interface SchematicScene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  groups: LinkGroup[];
  summary?: { nodes: number; nets: number };
  width: number;
  height: number;
}
export interface LayoutRequest {
  id: number;
  graph: SchematicGraph;
  expanded: string[];
  detail?: boolean;
}
export type LayoutResponse =
  | { id: number; stage: string }
  | { id: number; scene: SchematicScene; elapsedMs: number }
  | { id: number; error: string };
