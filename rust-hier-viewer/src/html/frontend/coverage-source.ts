import type { CoverageLineData } from "./coverage-types.js";
import type { SourceView } from "./main-types.js";

/** The provider has already verified the selected instance and module identity.
 * Accept a relocated source only with the same filename and matching report text
 * at every supplied line number. This verifies report excerpts, not an RTL revision.
 */
export function validateCoverageSource(data: CoverageLineData, sourcePath: string | null | undefined, view: SourceView): boolean {
  const reportPath = data.filePath.replace(/\\/g, "/");
  const bundledPath = sourcePath?.replace(/\\/g, "/");
  const relocated = reportPath !== bundledPath;
  const reportName = reportPath.split("/").at(-1);
  const bundledName = bundledPath?.split("/").at(-1);
  if (!reportName || !bundledName || (relocated && reportName !== bundledName)) {
    throw new Error(`Source file does not match the coverage report. Report: ${data.filePath}. Bundled RTL: ${sourcePath ?? "unknown"}.`);
  }

  const sourceLines = data.sourceLines ?? data.lines;
  if (relocated && sourceLines.length === 0) {
    throw new Error("Source paths differ and the report has no source text to verify the relocated file.");
  }
  for (const row of sourceLines) {
    const index = row.line - view.firstLineNumber;
    if (index < 0 || index >= (view.lines?.length ?? 0) || view.lines![index].trim() !== row.sourceText.trim()) {
      throw new Error(`Source text does not match the report at line ${row.line}; coverage overlay disabled.`);
    }
  }
  return relocated;
}
