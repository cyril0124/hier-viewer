import type {
  CoverageCounts,
  CoverageHierarchy,
  CoverageMapping,
  CoverageMetric,
  CoverageMetrics,
  CoverageScope,
  CoverageSummary,
} from "./coverage-types.js";

const METRICS: Readonly<Record<string, CoverageMetric>> = {
  Line: "line",
  Cond: "condition",
  Branch: "branch",
  Toggle: "toggle",
  Assert: "assert",
};

function fail(message: string): never {
  throw new Error(`Invalid coverage report: ${message}`);
}

function directElements(parent: Element): Element[] {
  const elements: Element[] = [];
  for (const child of parent.children) elements.push(child);
  return elements;
}

function requiredAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value === null || value === "") fail(`missing ${name} on <${element.tagName}>`);
  return value;
}

function parseInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) fail(`invalid ${label}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`unsafe ${label}: ${value}`);
  return parsed;
}

function parseCounts(metric: Element): CoverageCounts {
  const value = requiredAttribute(metric, "value");
  const match = /^(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value);
  if (!match) fail(`invalid metric value: ${value}`);
  const covered = parseInteger(match[1], "covered count");
  const total = parseInteger(match[2], "total count");
  const excluded = parseInteger(metric.getAttribute("excl") ?? "0", "excluded count");
  if (covered > total) fail(`covered count ${covered} exceeds total ${total}`);
  return { covered, total, excluded };
}

export function parseCoverageSummary(xml: string): CoverageSummary {
  if (/<!DOCTYPE\b/i.test(xml)) fail("DOCTYPE is not allowed");
  if (typeof DOMParser === "undefined") {
    throw new Error("Coverage XML parsing requires the browser DOMParser");
  }

  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length !== 0) fail("malformed XML");
  const session = document.documentElement;
  if (session.tagName !== "session" || session.getAttribute("version") !== "1.1") {
    fail("unsupported XML format");
  }
  const release = requiredAttribute(session, "release");
  const oldCoverage = directElements(session).filter((element) => element.tagName === "old_coverage");
  if (oldCoverage.length !== 1) fail("expected exactly one <old_coverage>");

  const scopes: CoverageScope[] = [];
  const roots: number[] = [];
  const byPath = new Map<string, number>();
  const pending: Array<{ element: Element; parent: number | null }> = [];
  const topScopes = directElements(oldCoverage[0]).filter((element) => element.tagName === "scope" && element.getAttribute("type") === "instance");
  for (let index = topScopes.length - 1; index >= 0; index -= 1) {
    pending.push({ element: topScopes[index], parent: null });
  }

  while (pending.length > 0) {
    const { element, parent } = pending.pop()!;
    if (element.getAttribute("type") !== "instance") fail("unsupported non-instance scope");
    const name = requiredAttribute(element, "name");
    if (name.includes(".")) fail(`scope name contains path separator: ${name}`);
    const path = parent === null ? name : `${scopes[parent].path}.${name}`;
    if (byPath.has(path)) fail(`duplicate scope path: ${path}`);

    const metrics: CoverageMetrics = {};
    for (const child of directElements(element)) {
      if (child.tagName !== "metric") continue;
      const metricName = requiredAttribute(child, "name");
      const metricKey = Object.hasOwn(METRICS, metricName) ? METRICS[metricName] : undefined;
      if (metricKey === undefined) continue;
      if (Object.hasOwn(metrics, metricKey)) fail(`duplicate ${metricName} metric at ${path}`);
      metrics[metricKey] = parseCounts(child);
    }

    const id = scopes.length;
    scopes.push({ name, path, parent, children: [], metrics });
    byPath.set(path, id);
    if (parent === null) roots.push(id);
    else scopes[parent].children.push(id);

    const childScopes = directElements(element).filter((child) => child.tagName === "scope" && child.getAttribute("type") === "instance");
    const childNames = new Set<string>();
    for (const child of childScopes) {
      const childName = requiredAttribute(child, "name");
      if (childNames.has(childName)) fail(`duplicate child scope ${childName} at ${path}`);
      childNames.add(childName);
    }
    for (let index = childScopes.length - 1; index >= 0; index -= 1) {
      pending.push({ element: childScopes[index], parent: id });
    }
  }

  if (roots.length === 0) fail("coverage hierarchy has no roots");
  return { release, scopes, roots, byPath };
}

function validId(id: number, length: number, label: string): void {
  if (!Number.isInteger(id) || id < 0 || id >= length) fail(`invalid ${label}: ${id}`);
}

function validateSummaryRoots(summary: CoverageSummary): void {
  const roots = new Uint8Array(summary.scopes.length);
  for (const root of summary.roots) {
    validId(root, summary.scopes.length, "coverage root");
    if (roots[root]) fail(`duplicate coverage root: ${root}`);
    roots[root] = 1;
    if (summary.scopes[root].parent !== null) fail(`coverage root ${root} has a parent`);
  }
  for (let id = 0; id < summary.scopes.length; id += 1) {
    if (summary.scopes[id].parent === null && !roots[id]) fail(`scope ${id} is missing from roots`);
    if (summary.scopes[id].parent !== null && roots[id]) fail(`non-root scope ${id} is in roots`);
  }
}

function validateScopeSubtree(summary: CoverageSummary, root: number): number[] {
  const order: number[] = [];
  const seen = new Uint8Array(summary.scopes.length);
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    validId(id, summary.scopes.length, "scope child");
    if (seen[id]) fail(`coverage hierarchy repeats scope ${id}`);
    seen[id] = 1;
    order.push(id);
    const scope = summary.scopes[id];
    const names = new Set<string>();
    for (let index = scope.children.length - 1; index >= 0; index -= 1) {
      const child = scope.children[index];
      validId(child, summary.scopes.length, "scope child");
      if (summary.scopes[child].parent !== id) fail(`scope ${child} has inconsistent parent`);
      const name = summary.scopes[child].name;
      if (names.has(name)) fail(`duplicate coverage child ${name} under ${scope.path}`);
      names.add(name);
      stack.push(child);
    }
  }
  return order;
}

function validateNodeSubtree(
  nodes: CoverageHierarchy,
  root: number,
): { order: number[]; childByName: Map<number, Map<string, number>> } {
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].id !== index) fail(`hierarchy node id ${nodes[index].id} does not match index ${index}`);
  }
  const order: number[] = [];
  const childByName = new Map<number, Map<string, number>>();
  const seen = new Uint8Array(nodes.length);
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    validId(id, nodes.length, "hierarchy child");
    if (seen[id]) fail(`hierarchy repeats node ${id}`);
    seen[id] = 1;
    order.push(id);
    const node = nodes[id];
    const names = new Map<string, number>();
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      validId(child, nodes.length, "hierarchy child");
      if (nodes[child].parent !== id) fail(`node ${child} has inconsistent parent`);
      const name = nodes[child].name;
      if (names.has(name)) fail(`duplicate hierarchy child ${name} under node ${id}`);
      names.set(name, child);
      stack.push(child);
    }
    childByName.set(id, names);
  }
  return { order, childByName };
}

export function mapCoverage(
  summary: CoverageSummary,
  sourceRoot: number,
  nodes: CoverageHierarchy,
  targetRoot: number,
): CoverageMapping {
  validId(sourceRoot, summary.scopes.length, "source root");
  validId(targetRoot, nodes.length, "target root");
  validateSummaryRoots(summary);
  const scopeOrder = validateScopeSubtree(summary, sourceRoot);
  const { order: nodeOrder, childByName } = validateNodeSubtree(nodes, targetRoot);

  const scopeByNode = new Int32Array(nodes.length);
  scopeByNode.fill(-1);
  const matchedScopes = new Uint8Array(summary.scopes.length);
  const pending: Array<[number, number]> = [[sourceRoot, targetRoot]];
  let matched = 0;

  while (pending.length > 0) {
    const [scopeId, nodeId] = pending.pop()!;
    scopeByNode[nodeId] = scopeId;
    matchedScopes[scopeId] = 1;
    matched += 1;
    const targetChildren = childByName.get(nodeId)!;
    const children = summary.scopes[scopeId].children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childScope = children[index];
      const childNode = targetChildren.get(summary.scopes[childScope].name);
      if (childNode !== undefined) pending.push([childScope, childNode]);
    }
  }

  const unmatchedScopes: string[] = [];
  for (const scopeId of scopeOrder) {
    if (!matchedScopes[scopeId]) unmatchedScopes.push(summary.scopes[scopeId].path);
  }
  const unmatchedNodeIds: number[] = [];
  for (const nodeId of nodeOrder) {
    if (scopeByNode[nodeId] === -1) unmatchedNodeIds.push(nodeId);
  }
  return { sourceRoot, targetRoot, scopeByNode, matched, unmatchedScopes, unmatchedNodeIds };
}
