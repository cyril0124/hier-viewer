import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type {
  CoverageCounts,
  CoverageFileSource,
  CoverageLine,
  CoverageLineData,
  CoverageLineProvider,
  CoverageMetric,
  CoverageMetricDetail,
  CoverageDetailBlock,
} from "./coverage-types.js";

type AstNode = DefaultTreeAdapterTypes.Node;
type AstElement = DefaultTreeAdapterTypes.Element;

interface ModulePage {
  filePath: string;
  sourcePath: string;
  instances: Map<string, string | null>;
  metricLinks: Map<string, Partial<Record<CoverageMetric, string>>>;
}

const CACHE_LIMIT = 8;
const MODULE_PAGE = /^mod\d+(?:_\d+)?\.html$/;
const MODULE_LIST = /^modlist\d*\.html$/;
const LINE_ANCHOR = /^(?:Line|.+_Line)$/;
const METRIC_ANCHOR = /^(?:Line|Cond|Toggle|Branch|Assert|.+_(?:Line|Cond|Toggle|Branch|Assert))$/;

function fail(message: string): never {
  throw new Error(`Invalid coverage HTML: ${message}`);
}

function isElement(node: AstNode): node is AstElement {
  return "tagName" in node;
}

function elements(root: AstNode): AstElement[] {
  const result: AstElement[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) result.push(node);
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
  }
  return result;
}

function descendants(root: AstElement, tagName?: string): AstElement[] {
  const result: AstElement[] = [];
  const stack: AstNode[] = [];
  for (let index = root.childNodes.length - 1; index >= 0; index -= 1) {
    stack.push(root.childNodes[index]);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (tagName === undefined || node.tagName === tagName) result.push(node);
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
  }
  return result;
}

function attribute(element: AstElement, name: string): string | null {
  return element.attrs.find((item) => item.name === name)?.value ?? null;
}

function nodeText(root: AstNode): string {
  const parts: string[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ("value" in node) {
      parts.push(node.value);
      continue;
    }
    if (isElement(node) && node.tagName === "br") parts.push("\n");
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
  }
  return parts.join("");
}

function normalizedText(node: AstNode): string {
  return nodeText(node).replace(/\s+/g, " ").trim();
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function normalizeListedPath(path: string): string {
  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) {
    fail(`unsafe report file path: ${path}`);
  }
  const output: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") fail(`unsafe report file path: ${path}`);
    output.push(part);
  }
  if (output.length === 0) fail("empty report file path");
  return output.join("/");
}

function looksLikeModulePageHref(href: string): boolean {
  let path = href.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return /^mod\d+/i.test(basename(path));
  }
  return MODULE_PAGE.test(basename(path));
}

function parseSafeHref(href: string, currentFile: string): { path: string; anchor: string } {
  const value = href.trim();
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("?") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)
  ) {
    fail(`unsafe report link: ${href}`);
  }
  const hash = value.indexOf("#");
  const rawPath = hash < 0 ? value : value.slice(0, hash);
  const rawAnchor = hash < 0 ? "" : value.slice(hash + 1);
  let decodedPath: string;
  let anchor: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
    anchor = decodeURIComponent(rawAnchor);
  } catch {
    fail(`invalid encoded report link: ${href}`);
  }
  const parent = dirname(currentFile);
  const joined = decodedPath === "" ? currentFile : parent === "" ? decodedPath : `${parent}/${decodedPath}`;
  return { path: normalizeListedPath(joined), anchor };
}

function parseNonnegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) fail(`invalid ${label}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`unsafe ${label}: ${value}`);
  return parsed;
}

function safeAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) fail(`unsafe ${label}`);
  return sum;
}

function directCells(row: AstElement): AstElement[] {
  const result: AstElement[] = [];
  for (const child of row.childNodes) {
    if (isElement(child) && (child.tagName === "td" || child.tagName === "th")) result.push(child);
  }
  return result;
}

function totalCounts(table: AstElement): CoverageCounts {
  let found: CoverageCounts | null = null;
  for (const row of descendants(table, "tr")) {
    const rowClass = attribute(row, "class") ?? "";
    const cells = directCells(row).map(normalizedText);
    if (/\bexcl(?:uded|usion)?\b/i.test(rowClass) || cells.some((cell) => /^excl(?:uded|usions?)?$/i.test(cell))) {
      fail("unsupported Line exclusion data");
    }
    if (cells[0]?.toUpperCase() !== "TOTAL") continue;
    if (found !== null) fail("duplicate Line TOTAL row");
    if (cells.length < 4) fail("incomplete Line TOTAL row");
    const total = parseNonnegativeInteger(cells[2], "Line total");
    const covered = parseNonnegativeInteger(cells[3], "Line covered count");
    if (covered > total) fail("Line covered count exceeds total");
    found = { covered, total, excluded: 0 };
  }
  if (found === null) fail("missing Line TOTAL row");
  return found;
}

function parseCode(pre: AstElement, expected: CoverageCounts): CoverageLine[] {
  const byLine = new Map<number, CoverageLine>();
  for (const rawLine of nodeText(pre).split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trim() === "MISSING_ELSE") continue;
    const numbered = /^\s*(\d+)/.exec(rawLine);
    if (!numbered) fail(`unrecognized Line code row: ${rawLine.trim()}`);
    if (rawLine.length < 26) fail(`incomplete Line code row: ${rawLine.trim()}`);
    const prefix = rawLine.slice(0, 26);
    const sourceText = rawLine.slice(26);
    const context = /^\s*(\d+)\s*$/.exec(prefix);
    if (context) {
      parseNonnegativeInteger(context[1], "source line number");
      continue;
    }
    const point = /^\s*(\d+)\s+(\d+)\s*\/\s*(\d+)(?:\s+==>)?\s*$/.exec(prefix);
    if (!point) fail(`unsupported Line coverage row: ${rawLine.trim()}`);
    const line = parseNonnegativeInteger(point[1], "source line number");
    const covered = parseNonnegativeInteger(point[2], "line covered count");
    const total = parseNonnegativeInteger(point[3], "line total");
    if (line === 0 || total === 0 || covered > total) fail(`invalid coverage points on line ${line}`);
    const previous = byLine.get(line);
    if (previous === undefined) {
      byLine.set(line, { line, covered, total, sourceText });
    } else {
      if (previous.sourceText !== sourceText) fail(`conflicting source text on line ${line}`);
      previous.covered = safeAdd(previous.covered, covered, `covered sum on line ${line}`);
      previous.total = safeAdd(previous.total, total, `total sum on line ${line}`);
      if (previous.covered > previous.total) fail(`covered sum exceeds total on line ${line}`);
    }
  }

  const lines = [...byLine.values()].sort((left, right) => left.line - right.line);
  let covered = 0;
  let total = 0;
  for (const line of lines) {
    covered = safeAdd(covered, line.covered, "Line covered total");
    total = safeAdd(total, line.total, "Line total");
  }
  if (covered !== expected.covered || total !== expected.total) {
    fail(`Line detail ${covered}/${total} does not match TOTAL ${expected.covered}/${expected.total}`);
  }
  return lines;
}

function hasCoverageHeader(section: AstElement[], prefix: string, target: string): boolean {
  for (const anchor of section) {
    if (anchor.tagName !== "a" || normalizedText(anchor) !== target || anchor.parentNode === null) continue;
    const siblings = anchor.parentNode.childNodes;
    const index = siblings.indexOf(anchor);
    if (index <= 0) continue;
    const before = normalizedText(siblings[index - 1]);
    if (before.endsWith(prefix)) return true;
  }
  return false;
}

function annotateAssertionRows(rows: Extract<CoverageDetailBlock, { kind: "table" }>["rows"]): void {
  const header = rows.find(row => row.header && row.cells.includes("Name") && row.cells.includes("Attempts"));
  if (!header) return;
  const successColumn = header.cells.indexOf("Real Successes");
  const matchColumn = header.cells.indexOf("Matches");
  const resultColumn = successColumn >= 0 ? successColumn : matchColumn;
  const failureColumn = header.cells.indexOf("Failures");
  const incompleteColumn = header.cells.indexOf("Incomplete");
  if (resultColumn < 0) fail("unsupported assertion result columns");
  for (const row of rows) {
    if (row.header) { row.cells.push("Outcome"); continue; }
    const result = parseNonnegativeInteger(row.cells[resultColumn] ?? "", "assertion result");
    const failures = failureColumn < 0 ? 0 : parseNonnegativeInteger(row.cells[failureColumn] ?? "", "assertion failures");
    const incomplete = incompleteColumn < 0 ? 0 : parseNonnegativeInteger(row.cells[incompleteColumn] ?? "", "incomplete assertions");
    parseNonnegativeInteger(row.cells[header.cells.indexOf("Attempts")] ?? "", "assertion attempts");
    row.status = failures > 0 ? "failed" : result > 0 && incomplete === 0 ? "covered" : "uncovered";
    row.cells.push(failures > 0 ? "Failed" : incomplete > 0 ? "Incomplete" : result > 0
      ? successColumn >= 0 ? "Succeeded" : "Matched"
      : successColumn >= 0 ? "No success" : "No match");
  }
}

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export class CoverageReport implements CoverageLineProvider {
  private readonly source: CoverageFileSource;
  private readonly files = new Map<string, string>();
  private readonly moduleLists: string[] = [];
  private moduleFiles: Map<string, string[]> | null = null;
  private readonly modulePages = new Map<string, ModulePage>();
  private readonly lineCache = new Map<string, CoverageLineData>();
  private readonly detailCache = new Map<string, CoverageMetricDetail>();

  constructor(source: CoverageFileSource) {
    this.source = source;
    for (const original of source.files) {
      const path = normalizeListedPath(original);
      if (this.files.has(path)) fail(`duplicate report file: ${path}`);
      this.files.set(path, original);
      if (MODULE_LIST.test(basename(path))) this.moduleLists.push(path);
    }
    this.moduleLists.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  clear(): void {
    this.moduleFiles = null;
    this.modulePages.clear();
    this.lineCache.clear();
    this.detailCache.clear();
  }

  async getLineCoverage(
    instancePath: string,
    moduleName: string,
    signal?: AbortSignal,
  ): Promise<CoverageLineData | null> {
    signal?.throwIfAborted();
    if (this.moduleLists.length === 0) return null;
    const modules = await this.getModuleFiles(signal);
    signal?.throwIfAborted();
    const candidates = modules.get(moduleName);
    if (candidates === undefined) return null;
    if (candidates.length !== 1) fail(`ambiguous module page for ${moduleName}`);

    const modulePage = await this.getModulePage(candidates[0], signal);
    signal?.throwIfAborted();
    const lineHref = modulePage.instances.get(instancePath);
    if (lineHref === undefined) return null;
    if (lineHref === null) return null;
    const target = parseSafeHref(lineHref, modulePage.filePath);
    if (!LINE_ANCHOR.test(target.anchor)) fail(`invalid Line anchor for ${instancePath}`);
    this.requireFile(target.path);

    const cacheKey = `${target.path}#${target.anchor}\n${instancePath}`;
    const cached = lruGet(this.lineCache, cacheKey);
    if (cached !== undefined) return cached;
    const html = await this.read(target.path, signal);
    signal?.throwIfAborted();
    const document = parse(html);
    signal?.throwIfAborted();
    const data = this.parseLineSection(
      document,
      target.path,
      target.anchor,
      instancePath,
      moduleName,
      modulePage.sourcePath,
      modulePage.instances.size === 1,
    );
    signal?.throwIfAborted();
    lruSet(this.lineCache, cacheKey, data);
    return data;
  }

  async getMetricDetail(instancePath: string, moduleName: string, metric: Exclude<CoverageMetric, "line">, signal?: AbortSignal): Promise<CoverageMetricDetail | null> {
    signal?.throwIfAborted();
    if (!this.moduleLists.length) return null;
    const modules = await this.getModuleFiles(signal);
    const candidates = modules.get(moduleName);
    if (!candidates) return null;
    if (candidates.length !== 1) fail(`ambiguous module page for ${moduleName}`);
    const page = await this.getModulePage(candidates[0], signal);
    const href = page.metricLinks.get(instancePath)?.[metric];
    if (!href) return null;
    const target = parseSafeHref(href, page.filePath);
    const key = `${target.path}#${target.anchor}\n${instancePath}`;
    const cached = lruGet(this.detailCache, key);
    signal?.throwIfAborted();
    if (cached) return cached;
    const html = await this.read(target.path, signal);
    signal?.throwIfAborted();
    const all = elements(parse(html));
    const label = metric === "condition" ? "Cond" : metric === "branch" ? "Branch" : metric === "assert" ? "Assert" : "Toggle";
    const anchors = all.filter(element => element.tagName === "a" && attribute(element, "name") === target.anchor);
    if (anchors.length !== 1) fail(`missing or duplicate #${target.anchor}`);
    const start = all.indexOf(anchors[0]);
    let end = all.length;
    let owner: AstNode | null = anchors[0].parentNode;
    while (owner && !(isElement(owner) && owner.tagName === "div" && attribute(owner, "name"))) {
      owner = "parentNode" in owner ? owner.parentNode : null;
    }
    if (owner) {
      const ownerElements = elements(owner);
      end = all.indexOf(ownerElements[ownerElements.length - 1]) + 1;
    }
    for (let index = start + 1; index < end; index++) {
      if (all[index].tagName === "a" && METRIC_ANCHOR.test(attribute(all[index], "name") || "")) { end = index; break; }
    }
    const section = all.slice(start + 1, end);
    const aggregate = target.anchor === label;
    if (aggregate && (page.instances.size !== 1 || !page.instances.has(instancePath))) fail("module metric used for multiple instances");
    if (!hasCoverageHeader(all, "Module Instance :", instancePath)
      || !hasCoverageHeader(section, `${label} Coverage for ${aggregate ? "Module" : "Instance"} :`, aggregate ? moduleName : instancePath)) {
      fail(`detail header does not match ${instancePath}`);
    }
    const blocks: CoverageDetailBlock[] = [];
    let tableTitle = "";
    for (const element of section) {
      if (element.tagName === "b" && /Details/.test(normalizedText(element))) tableTitle = normalizedText(element);
      if (element.tagName === "iframe") fail("embedded detail pages are unsupported");
      if (element.tagName === "pre") blocks.push({ kind: "code", text: nodeText(element).trim() });
      if (element.tagName === "table") {
        const rows = descendants(element, "tr").map(row => {
          const cells = directCells(row);
          const texts = cells.map(normalizedText);
          return {
            cells: texts,
            header: cells.some(cell => cell.tagName === "th") || (attribute(row, "class") || "").includes("sortablehead"),
            status: texts.includes("Not Covered") || texts.includes("No") ? "uncovered" as const
              : texts.includes("Covered") || texts.includes("Yes") ? "covered" as const : "neutral" as const,
          };
        }).filter(row => row.cells.length);
        if (rows.length) {
          if (metric === "assert") annotateAssertionRows(rows);
          blocks.push({ kind: "table", rows, ...(tableTitle ? { title: tableTitle } : {}) });
          tableTitle = "";
        }
      }
    }
    if (!blocks.length) fail(`empty ${label} details`);
    signal?.throwIfAborted();
    const result = { instancePath, filePath: page.sourcePath, metric, blocks };
    lruSet(this.detailCache, key, result);
    return result;
  }

  private async getModuleFiles(signal?: AbortSignal): Promise<Map<string, string[]>> {
    if (this.moduleFiles !== null) return this.moduleFiles;
    const result = new Map<string, string[]>();
    for (const listPath of this.moduleLists) {
      signal?.throwIfAborted();
      const html = await this.read(listPath, signal);
      signal?.throwIfAborted();
      const document = parse(html);
      signal?.throwIfAborted();
      for (const anchor of elements(document).filter((element) => element.tagName === "a")) {
        const href = attribute(anchor, "href");
        const name = normalizedText(anchor);
        if (href === null || name === "" || href.includes("#")) continue;
        let target: { path: string; anchor: string };
        try {
          target = parseSafeHref(href, listPath);
        } catch {
          if (looksLikeModulePageHref(href)) throw new Error(`Invalid coverage HTML: unsafe module link: ${href}`);
          continue;
        }
        if (!MODULE_PAGE.test(basename(target.path))) continue;
        this.requireFile(target.path);
        const paths = result.get(name);
        if (paths === undefined) result.set(name, [target.path]);
        else if (!paths.includes(target.path)) paths.push(target.path);
      }
    }
    signal?.throwIfAborted();
    this.moduleFiles = result;
    return result;
  }

  private async getModulePage(path: string, signal?: AbortSignal): Promise<ModulePage> {
    const cached = lruGet(this.modulePages, path);
    if (cached !== undefined) return cached;
    const html = await this.read(path, signal);
    signal?.throwIfAborted();
    const document = parse(html);
    signal?.throwIfAborted();
    const all = elements(document);
    const sourceMarker = all.findIndex((element) => normalizedText(element) === "Source File(s) :");
    const instanceMarker = all.findIndex((element) => normalizedText(element) === "Module self-instances :");
    if (sourceMarker < 0 || instanceMarker <= sourceMarker) fail(`missing module metadata in ${path}`);

    const sourcePaths = new Set<string>();
    for (let index = sourceMarker + 1; index < instanceMarker; index += 1) {
      if (all[index].tagName !== "a") continue;
      const text = normalizedText(all[index]);
      if (text !== "") sourcePaths.add(text);
    }
    if (sourcePaths.size !== 1) fail(`ambiguous Source File(s) in ${path}`);

    let table: AstElement | null = null;
    for (let index = instanceMarker + 1; index < all.length; index += 1) {
      if (all[index].tagName === "table") {
        table = all[index];
        break;
      }
    }
    if (table === null) fail(`missing Module self-instances table in ${path}`);
    const instances = new Map<string, string | null>();
    const metricLinks = new Map<string, Partial<Record<CoverageMetric, string>>>();
    for (const row of descendants(table, "tr")) {
      const anchors = descendants(row, "a");
      if (anchors.length === 0) continue;
      const instancePath = normalizedText(anchors[0]);
      if (instancePath === "" || instancePath.toUpperCase() === "NAME") continue;
      let lineHref: string | null = null;
      const links: Partial<Record<CoverageMetric, string>> = {};
      for (const anchor of anchors) {
        const href = attribute(anchor, "href");
        if (href === null) continue;
        const hash = href.indexOf("#");
        const name = hash >= 0 ? href.slice(hash + 1).split("_").at(-1) : "";
        const metric: CoverageMetric | null = name === "Line" ? "line" : name === "Cond" ? "condition" : name === "Branch" ? "branch" : name === "Toggle" ? "toggle" : name === "Assert" ? "assert" : null;
        if (metric) {
          if (links[metric] && links[metric] !== href) fail(`duplicate ${metric} links for ${instancePath}`);
          links[metric] = href;
        }
        if (hash >= 0 && LINE_ANCHOR.test(href.slice(hash + 1))) {
          if (lineHref !== null && lineHref !== href) fail(`duplicate Line links for ${instancePath}`);
          lineHref = href;
        }
      }
      if (instances.has(instancePath)) fail(`duplicate self-instance ${instancePath}`);
      instances.set(instancePath, lineHref);
      metricLinks.set(instancePath, links);
    }
    if (instances.size === 0) fail(`empty Module self-instances table in ${path}`);

    const page = { filePath: path, sourcePath: [...sourcePaths][0], instances, metricLinks };
    signal?.throwIfAborted();
    lruSet(this.modulePages, path, page);
    return page;
  }

  private parseLineSection(
    document: DefaultTreeAdapterTypes.Document,
    reportFile: string,
    anchorName: string,
    instancePath: string,
    moduleName: string,
    sourcePath: string,
    singleInstance: boolean,
  ): CoverageLineData {
    const all = elements(document);
    if (!hasCoverageHeader(all, "Module Instance :", instancePath)) {
      fail(`detail header does not match ${instancePath}`);
    }
    const anchors = all.filter(
      (element) => element.tagName === "a" && attribute(element, "name") === anchorName,
    );
    if (anchors.length !== 1) fail(`expected one #${anchorName} in ${reportFile}`);
    const start = all.indexOf(anchors[0]);
    let end = all.length;
    for (let index = start + 1; index < all.length; index += 1) {
      const name = all[index].tagName === "a" ? attribute(all[index], "name") : null;
      if (name !== null && METRIC_ANCHOR.test(name)) {
        end = index;
        break;
      }
    }
    const section = all.slice(start + 1, end);
    const headerPrefix = anchorName === "Line"
      ? "Line Coverage for Module :"
      : "Line Coverage for Instance :";
    const headerTarget = anchorName === "Line" ? moduleName : instancePath;
    if (anchorName === "Line" && !singleInstance) fail("module Line section used for multiple instances");
    if (!hasCoverageHeader(section, headerPrefix, headerTarget)) {
      fail(`Line header does not match ${instancePath}`);
    }

    const tables = section.filter((element) => element.tagName === "table");
    if (tables.length === 0) fail(`missing Line TOTAL table for ${instancePath}`);
    const totals = totalCounts(tables[0]);
    const code = section.filter(
      (element) => element.tagName === "pre" && (attribute(element, "class") ?? "").split(/\s+/).includes("code"),
    );
    if (code.length !== 1) fail(`expected one Line code block for ${instancePath}`);
    const lines = parseCode(code[0], totals);
    return {
      instancePath,
      filePath: sourcePath,
      lines,
      totals,
      reportPath: `${reportFile}#${anchorName}`,
    };
  }

  private requireFile(path: string): string {
    const original = this.files.get(path);
    if (original === undefined) fail(`missing report file: ${path}`);
    return original;
  }

  private async read(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const text = await this.source.readText(this.requireFile(path), signal);
    signal?.throwIfAborted();
    return text;
  }
}
