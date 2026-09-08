import type { HierarchyNode } from "./types.js";
import type { CoverageFileSource, CoverageMapping, CoverageMetric, CoverageSelection, CoverageSummary } from "./coverage-types.js";
import { parseCoverageSummary, mapCoverage, inferCoverageRoot } from "./coverage.js";
import { CoverageReport } from "./coverage-report.js";

interface Capabilities { available: boolean; vdbAvailable: boolean; token: string }
interface ReportDescriptor { id: string; name: string; files: string[]; baseUrl: string; reportUrl?: string }
interface ImportJob { id: string; state: "running" | "ready" | "failed" | "cancelled"; error?: string; report?: ReportDescriptor }
interface PendingReport { source: CoverageFileSource; summary: CoverageSummary; report: CoverageReport }
interface ImportDependencies {
  nodes: HierarchyNode[];
  homeRoot: number;
  getTargetRoot(): number;
  onApply(selection: CoverageSelection): void;
  onClear(): void;
  onMetricChange(metric: "off" | CoverageMetric): void;
}

let localSourceId = 0;

export function browserReportSource(files: readonly File[], sessionPath: string): CoverageFileSource {
  const root = sessionPath.slice(0, sessionPath.lastIndexOf("/") + 1);
  const entries = new Map<string, File>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    if (!relative || relative.split("/").some(part => part === ".." || part === "." || !part)) continue;
    if (entries.has(relative)) throw new Error(`Duplicate report file: ${relative}`);
    entries.set(relative, file);
  }
  if (!entries.has("session.xml")) throw new Error("Report is missing session.xml.");
  return {
    id: `browser-${++localSourceId}`,
    name: root.replace(/\/$/, "") || "session.xml",
    files: [...entries.keys()],
    async readText(path, signal) {
      signal?.throwIfAborted();
      const file = entries.get(path);
      if (!file) throw new Error(`Report file is missing: ${path}`);
      const text = await file.text();
      signal?.throwIfAborted();
      return text;
    },
    dispose() { entries.clear(); },
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try { message = (JSON.parse(body) as { error?: string }).error || body; } catch { /* Plain HTTP errors are also useful. */ }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return await response.json() as T;
}

function delay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new DOMException("Import cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createCoverageImport(deps: ImportDependencies) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = element<HTMLDialogElement>("coverage-import-dialog");
  const mode = element<HTMLSelectElement>("coverage-import-mode");
  const filesInput = element<HTMLInputElement>("coverage-files");
  const folderInput = element<HTMLInputElement>("coverage-folder");
  const browserFields = element<HTMLDivElement>("coverage-browser-fields");
  const serverFields = element<HTMLDivElement>("coverage-server-fields");
  const pathInput = element<HTMLInputElement>("coverage-server-path");
  const timeoutField = element<HTMLLabelElement>("coverage-timeout-field");
  const timeoutInput = element<HTMLInputElement>("coverage-timeout");
  const sessionSelect = element<HTMLSelectElement>("coverage-session-select");
  const sessionField = element<HTMLLabelElement>("coverage-session-field");
  const rootInput = element<HTMLInputElement>("coverage-root-input");
  const targetSelect = element<HTMLSelectElement>("coverage-target-select");
  const mappingFields = element<HTMLDivElement>("coverage-mapping-fields");
  const mappingResult = element<HTMLDivElement>("coverage-mapping-result");
  const unmatched = element<HTMLTextAreaElement>("coverage-unmatched");
  const unmatchedDetails = element<HTMLDetailsElement>("coverage-unmatched-details");
  const status = element<HTMLDivElement>("coverage-import-status");
  const loadButton = element<HTMLButtonElement>("coverage-load-btn");
  const applyButton = element<HTMLButtonElement>("coverage-apply-btn");
  const cancelButton = element<HTMLButtonElement>("coverage-cancel-btn");
  const clearButton = element<HTMLButtonElement>("coverage-clear-btn");
  const metricSelect = element<HTMLSelectElement>("coverage-metric-select");
  const legend = element<HTMLDivElement>("coverage-legend");
  let capabilities: Capabilities | null = null;
  let operation: AbortController | null = null;
  let pending: PendingReport | null = null;
  let mapping: CoverageMapping | null = null;
  let chosenFiles: File[] = [];
  let jobId: string | null = null;
  let generation = 0;
  let busy = false;

  function setStatus(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle("coverage-error", error);
  }
  function setBusy(value: boolean) {
    busy = value;
    loadButton.disabled = value;
    mode.disabled = value;
    filesInput.disabled = value;
    folderInput.disabled = value;
    applyButton.disabled = value || !mapping;
    dialog.setAttribute("aria-busy", String(value));
  }
  async function releaseJob(id: string) {
    if (!capabilities) return;
    await fetch(`/api/coverage/jobs/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { "X-Hier-Token": capabilities.token }, keepalive: true,
    }).catch(() => undefined);
  }
  function discardPending() {
    pending?.report.clear();
    pending?.source.dispose?.();
    pending = null;
    mapping = null;
    mappingFields.hidden = true;
    applyButton.disabled = true;
  }
  function cancelOperation() {
    generation++;
    operation?.abort();
    operation = null;
    if (jobId) void releaseJob(jobId);
    jobId = null;
    discardPending();
    setBusy(false);
  }
  function updateMode() {
    cancelOperation();
    const browser = mode.value === "files";
    browserFields.hidden = !browser;
    serverFields.hidden = browser;
    timeoutField.hidden = mode.value !== "vdb";
    setStatus(!browser && !capabilities?.available ? "Local coverage service unavailable." : "");
    loadButton.hidden = browser;
  }
  async function loadCapabilities() {
    try {
      const response = await fetch("/api/coverage/capabilities", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json() as Capabilities;
      if (result.available && typeof result.token === "string") capabilities = result;
    } catch { /* Report files remain usable on a plain static server. */ }
  }
  function updateMapping() {
    mapping = null;
    applyButton.disabled = true;
    if (!pending) return;
    try {
      const sourceRoot = pending.summary.byPath.get(rootInput.value.trim());
      if (sourceRoot === undefined) throw new Error("Coverage root does not exist in this report.");
      const result = mapCoverage(pending.summary, sourceRoot, deps.nodes, Number(targetSelect.value));
      mapping = result;
      mappingResult.textContent = `${result.matched} matched; ${result.unmatchedScopes.length} unmatched coverage instances; ${result.unmatchedNodeIds.length} hierarchy instances without data`;
      const missingTargets = result.unmatchedNodeIds.map(id => deps.nodes[id].path || deps.nodes[id].name);
      unmatched.value = [
        ...result.unmatchedScopes.map(path => `Coverage: ${path}`),
        ...missingTargets.map(path => `Hierarchy: ${path}`),
      ].join("\n");
      unmatchedDetails.hidden = !unmatched.value;
      applyButton.disabled = busy || result.matched === 0;
    } catch (error) {
      mappingResult.textContent = error instanceof Error ? error.message : String(error);
      unmatchedDetails.hidden = true;
    }
  }
  async function inspectSource(source: CoverageFileSource, controller: AbortController, token: number) {
    try {
      const xml = await source.readText("session.xml", controller.signal);
      controller.signal.throwIfAborted();
      const summary = parseCoverageSummary(xml);
      if (token !== generation) { source.dispose?.(); return; }
      pending = { source, summary, report: new CoverageReport(source) };
      rootInput.value = summary.scopes[summary.roots[0]]?.path || "";
      mappingFields.hidden = false;
      setBusy(false);
      updateMapping();
      const hasDetails = source.files.some(path => /(?:^|\/)modlist\d*\.html$/.test(path));
      setStatus(`${summary.scopes.length} coverage instances${hasDetails ? "" : "; line detail files unavailable"}`);
    } catch (error) {
      source.dispose?.();
      throw error;
    }
  }
  async function loadBrowserSession() {
    cancelOperation();
    const token = generation;
    const controller = new AbortController();
    operation = controller;
    setBusy(true);
    setStatus("Reading report...");
    try {
      await inspectSource(browserReportSource(chosenFiles, sessionSelect.value), controller, token);
    } catch (error) {
      if (token === generation && !controller.signal.aborted) setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (token === generation) setBusy(false);
    }
  }
  function acceptFiles(list: FileList | null) {
    if (!list?.length) return;
    cancelOperation();
    chosenFiles = [...list];
    const sessions = chosenFiles.map(file => file.webkitRelativePath || file.name).filter(path => path.split("/").at(-1) === "session.xml");
    sessionSelect.replaceChildren(...sessions.map(path => new Option(path, path)));
    sessionField.hidden = sessions.length <= 1;
    if (!sessions.length) { setStatus("Report is missing session.xml.", true); return; }
    if (sessions.length > 1) {
      sessionSelect.prepend(new Option("Select session.xml", "", true, true));
      setStatus(`${sessions.length} report sessions found.`);
      return;
    }
    void loadBrowserSession();
  }
  function serverSource(report: ReportDescriptor, id: string): CoverageFileSource {
    if (!capabilities) throw new Error("Local coverage service unavailable.");
    const token = capabilities.token;
    const base = new URL(report.baseUrl, location.href);
    if (base.origin !== location.origin || !base.pathname.startsWith("/api/coverage/files/")) throw new Error("Invalid report URL.");
    const reportUrl = report.reportUrl ? new URL(report.reportUrl, location.href) : null;
    if (reportUrl && reportUrl.origin !== location.origin) throw new Error("Invalid original report URL.");
    return {
      id: report.id, name: report.name, files: report.files, reportUrl: reportUrl?.href,
      async readText(path, signal) {
        signal?.throwIfAborted();
        if (!report.files.includes(path) || path.split("/").some(part => part === ".." || part === "." || !part)) throw new Error(`Invalid report path: ${path}`);
        const response = await fetch(new URL(path.split("/").map(encodeURIComponent).join("/"), base), {
          signal, headers: { "X-Hier-Token": token }, cache: "no-store",
        });
        if (!response.ok) throw new Error(`Unable to read ${path}: HTTP ${response.status}`);
        return response.text();
      },
      dispose() { void releaseJob(id); },
    };
  }
  async function loadServerReport() {
    cancelOperation();
    if (!capabilities?.available) { setStatus("Local coverage service unavailable.", true); return; }
    if (mode.value === "vdb" && !capabilities.vdbAvailable) { setStatus("URG is unavailable on the server.", true); return; }
    const path = pathInput.value.trim();
    const timeoutMinutes = mode.value === "vdb" ? Number(timeoutInput.value) : 60;
    if (!path) { setStatus("A server directory path is required.", true); return; }
    if ((mode.value === "vdb" && !timeoutInput.value.trim()) || !Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 0) { setStatus("Timeout must be a nonnegative integer; 0 is unlimited.", true); return; }
    const controller = new AbortController();
    operation = controller;
    const token = generation;
    const started = performance.now();
    setBusy(true);
    setStatus("Starting import...");
    try {
      let job = await responseJson<ImportJob>(await fetch("/api/coverage/import", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Hier-Token": capabilities.token },
        body: JSON.stringify({ kind: mode.value === "vdb" ? "vdb" : "report", path, timeoutMinutes }),
      }));
      if (token !== generation) { void releaseJob(job.id); return; }
      jobId = job.id;
      while (job.state === "running") {
        setStatus(`URG running: ${Math.floor((performance.now() - started) / 1000)}s elapsed${timeoutMinutes === 0 ? "; unlimited" : `; ${timeoutMinutes} min limit`}`);
        await delay(controller.signal, 500);
        job = await responseJson<ImportJob>(await fetch(`/api/coverage/jobs/${encodeURIComponent(job.id)}`, {
          signal: controller.signal, headers: { "X-Hier-Token": capabilities.token }, cache: "no-store",
        }));
      }
      if (job.state !== "ready" || !job.report) throw new Error(job.error || `Import ${job.state}.`);
      const source = serverSource(job.report, job.id);
      jobId = null;
      await inspectSource(source, controller, token);
    } catch (error) {
      if (token === generation && !controller.signal.aborted) {
        if (jobId) void releaseJob(jobId);
        jobId = null;
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      if (token === generation) setBusy(false);
    }
  }

  function applySelection(selection: CoverageSelection) {
    const assertOption = metricSelect.querySelector<HTMLOptionElement>('option[value="assert"]')!;
    const hasAssertions = selection.display.mapping.scopeByNode.some(id => id >= 0 && !!selection.display.summary.scopes[id].metrics.assert);
    assertOption.hidden = !hasAssertions;
    assertOption.disabled = !hasAssertions;
    metricSelect.disabled = false;
    metricSelect.value = "line";
    clearButton.disabled = false;
    legend.hidden = false;
    deps.onApply(selection);
  }

  async function loadBundled(manifestPath: string) {
    cancelOperation();
    const controller = new AbortController();
    operation = controller;
    const manifestUrl = new URL(manifestPath, location.href);
    if (manifestUrl.origin !== location.origin) throw new Error("Bundled coverage must be served from this site.");
    const config = await responseJson<{ name: string; root?: string; files: string[] }>(await fetch(manifestUrl, { signal: controller.signal, cache: "no-store" }));
    const invalidRoot = config.root !== undefined && typeof config.root !== "string";
    if (typeof config.name !== "string" || invalidRoot || !Array.isArray(config.files)
      || config.files.some(path => typeof path !== "string" || path.includes("\\") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === ".."))) {
      throw new Error("Invalid bundled coverage manifest.");
    }
    const files = new Set(config.files);
    if (!files.has("session.xml")) throw new Error("Bundled report is missing session.xml.");
    const source: CoverageFileSource = {
      id: manifestUrl.href, name: config.name, files: config.files,
      async readText(path, signal) {
        if (!files.has(path)) throw new Error(`Report file is missing: ${path}`);
        const url = new URL(path.split("/").map(encodeURIComponent).join("/"), manifestUrl);
        const response = await fetch(url, { signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Unable to read ${path}: HTTP ${response.status}`);
        return response.text();
      },
    };
    const summary = parseCoverageSummary(await source.readText("session.xml", controller.signal));
    controller.signal.throwIfAborted();
    const root = config.root === undefined
      ? inferCoverageRoot(summary, deps.nodes, deps.homeRoot)
      : summary.byPath.get(config.root);
    if (root === undefined) throw new Error(`Bundled coverage root does not exist: ${config.root}. Check --coverage-root <path>.`);
    const mapped = mapCoverage(summary, root, deps.nodes, deps.homeRoot);
    if (mapped.unmatchedScopes.length || mapped.unmatchedNodeIds.length) throw new Error("Bundled coverage does not match the hierarchy.");
    applySelection({ source, report: new CoverageReport(source), display: { summary, mapping: mapped, metric: "line", name: source.name } });
    operation = null;
  }

  function open() {
    cancelOperation();
    setStatus("");
    filesInput.value = "";
    folderInput.value = "";
    const targets = [...new Set([deps.getTargetRoot(), deps.homeRoot])];
    targetSelect.replaceChildren(...targets.map(id => new Option(deps.nodes[id].path || deps.nodes[id].name, String(id))));
    dialog.showModal();
    void loadCapabilities().then(() => {
      if (mode.value !== "files") setStatus(capabilities?.available ? "" : "Local coverage service unavailable.");
    });
  }
  mode.addEventListener("change", updateMode);
  filesInput.addEventListener("change", () => acceptFiles(filesInput.files));
  folderInput.addEventListener("change", () => acceptFiles(folderInput.files));
  sessionSelect.addEventListener("change", () => { if (sessionSelect.value) void loadBrowserSession(); });
  rootInput.addEventListener("change", updateMapping);
  rootInput.addEventListener("input", () => { mapping = null; applyButton.disabled = true; });
  targetSelect.addEventListener("change", updateMapping);
  element<HTMLButtonElement>("coverage-preview-btn").addEventListener("click", updateMapping);
  loadButton.addEventListener("click", () => { void loadServerReport(); });
  cancelButton.addEventListener("click", () => { cancelOperation(); dialog.close(); });
  dialog.addEventListener("cancel", () => cancelOperation());
  applyButton.addEventListener("click", () => {
    updateMapping();
    if (!pending || !mapping) return;
    const selection: CoverageSelection = {
      source: pending.source, report: pending.report,
      display: { summary: pending.summary, mapping, metric: "line", name: pending.source.name, reportUrl: pending.source.reportUrl },
    };
    pending = null;
    mapping = null;
    operation = null;
    applySelection(selection);
    dialog.close();
  });
  function disableColor() {
    metricSelect.value = "off";
    clearButton.disabled = true;
    legend.hidden = true;
  }

  function remove() {
    cancelOperation();
    deps.onClear();
    disableColor();
    metricSelect.disabled = true;
  }

  clearButton.addEventListener("click", () => {
    disableColor();
    deps.onMetricChange("off");
  });
  metricSelect.addEventListener("change", () => {
    const metric = metricSelect.value as "off" | CoverageMetric;
    clearButton.disabled = metric === "off";
    legend.hidden = metric === "off";
    deps.onMetricChange(metric);
  });
  window.addEventListener("pagehide", cancelOperation);
  updateMode();
  return {
    open,
    loadBundled,
    remove,
    disableColor,
    setViewVisible(treemap: boolean) { legend.hidden = !treemap || metricSelect.value === "off"; },
    dispose: cancelOperation,
  };
}
