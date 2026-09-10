import type { HierarchyNode, ViewerData, AnalysisDefinition, DefinitionSignalStat } from "./types.js";
import type { BinaryReader } from "./main-types.js";

function decodeSchematicMetadata(value: unknown): ViewerData["schematic"] {
  if (value === undefined || value === null) return null;
  const meta = value as Record<string, unknown>;
  if (typeof value !== "object" || meta.version !== 1 || meta.directory !== "schematic"
    || (meta.mode !== undefined && meta.mode !== "lazy" && meta.mode !== "static")) {
    throw new Error("Invalid schematic bundle metadata. Regenerate the RTL bundle.");
  }
  const schematic: NonNullable<ViewerData["schematic"]> = { version: 1, directory: "schematic" };
  if (meta.mode !== undefined) schematic.mode = meta.mode;
  return schematic;
}

    export const CORE_BUNDLE_MAGIC = "HVC1";

    export const ANALYSIS_BUNDLE_MAGIC = "HVA1";

    export const BUNDLE_FORMAT_VERSION = 1;

    export const utf8Decoder = new TextDecoder();

    export function decodeAscii(bytes: Uint8Array, offset: number, length: number) {
      let value = "";
      for (let index = 0; index < length; index += 1) {
        value += String.fromCharCode(bytes[offset + index]);
      }
      return value;
    }

    export function createBinaryReader(buffer: ArrayBuffer): BinaryReader {
      return {
        buffer,
        bytes: new Uint8Array(buffer),
        view: new DataView(buffer),
        offset: 0,
        ensure(byteLength, label) {
          if (this.offset + byteLength > this.view.byteLength) {
            throw new Error(`${label} truncated at byte ${this.offset}`);
          }
        },
        readMagic(label) {
          this.ensure(4, `${label} header`);
          const magic = decodeAscii(this.bytes, this.offset, 4);
          this.offset += 4;
          return magic;
        },
        readU32(label) {
          this.ensure(4, label);
          const value = this.view.getUint32(this.offset, true);
          this.offset += 4;
          return value;
        },
        readOptionalU32(label) {
          const value = this.readU32(label);
          return value === 0xFFFFFFFF ? null : value;
        },
        readU64Number(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          return high * 4294967296 + low;
        },
        readOptionalU64Key(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          if (low === 0xFFFFFFFF && high === 0xFFFFFFFF) {
            return null;
          }
          return ((BigInt(high) << 32n) | BigInt(low)).toString();
        },
        readU64Key(label) {
          const low = this.readU32(`${label} (low)`);
          const high = this.readU32(`${label} (high)`);
          return ((BigInt(high) << 32n) | BigInt(low)).toString();
        },
        readStringTable(label) {
          const stringCount = this.readU32(`${label} string count`);
          const strings = new Array<string>(stringCount);
          for (let index = 0; index < stringCount; index += 1) {
            const byteLength = this.readU32(`${label} string length`);
            this.ensure(byteLength, `${label} string bytes`);
            strings[index] = utf8Decoder.decode(
              this.bytes.subarray(this.offset, this.offset + byteLength)
            );
            this.offset += byteLength;
          }
          return strings;
        }
      };
    }

    export function readColumn<T>(reader: BinaryReader, count: number, label: string, readValue: (reader: BinaryReader, label: string) => T): T[] {
      const values = new Array<T>(count);
      for (let index = 0; index < count; index += 1) {
        values[index] = readValue(reader, `${label}[${index}]`);
      }
      return values;
    }

    export function stringAt(strings: string[], index: number | null | undefined, label: string) {
      if (index === null || index === undefined) {
        return null;
      }
      const value = strings[index];
      if (value === undefined) {
        throw new Error(`${label} references missing string id ${index}`);
      }
      return value;
    }

    export function defineLazyNodePath(node: HierarchyNode, nodeId: number, nodes: HierarchyNode[], rootId: number, cache: (string | undefined)[]) {
      Object.defineProperty(node, "path", {
        enumerable: true,
        configurable: true,
        get() {
          const cached = cache[nodeId];
          if (cached !== undefined) {
            return cached;
          }
          let value = "";
          if (!(nodeId === rootId || node.parent === null || node.parent === undefined)) {
            const parentPath = nodes[node.parent].path;
            value = parentPath ? `${parentPath}.${node.name}` : node.name;
          }
          cache[nodeId] = value;
          return value;
        }
      });
    }

    export function decodeCoreBundle(buffer: ArrayBuffer, meta: Record<string, unknown>): ViewerData {
      const reader = createBinaryReader(buffer);
      const magic = reader.readMagic("viewer-core.bin");
      if (magic !== CORE_BUNDLE_MAGIC) {
        throw new Error(`viewer-core.bin has unsupported magic '${magic}'`);
      }
      const version = reader.readU32("viewer-core.bin version");
      if (version !== BUNDLE_FORMAT_VERSION) {
        throw new Error(`viewer-core.bin has unsupported version ${version}`);
      }
      const strings = reader.readStringTable("viewer-core.bin");
      const nodeCount = reader.readU32("viewer-core.bin node count");

      const nameIds = readColumn(reader, nodeCount, "name id", (stream, label) => stream.readU32(label));
      const moduleIds = readColumn(reader, nodeCount, "module id", (stream, label) => stream.readU32(label));
      const definitionKeys = readColumn(reader, nodeCount, "definition key", (stream, label) => stream.readOptionalU64Key(label));
      const parents = readColumn(reader, nodeCount, "parent id", (stream, label) => stream.readOptionalU32(label));
      const subtreeInstances = readColumn(reader, nodeCount, "subtree instances", (stream, label) => stream.readU32(label));
      const subtreeLeaves = readColumn(reader, nodeCount, "subtree leaves", (stream, label) => stream.readU32(label));
      const subtreeSignalCounts = readColumn(reader, nodeCount, "subtree signal count", (stream, label) => stream.readU32(label));
      const subtreeInternalSignalCounts = readColumn(reader, nodeCount, "subtree internal signal count", (stream, label) => stream.readU32(label));
      const subtreeVariableBits = readColumn(reader, nodeCount, "subtree variable bits", (stream, label) => stream.readU64Number(label));
      const subtreeNetBits = readColumn(reader, nodeCount, "subtree net bits", (stream, label) => stream.readU64Number(label));
      const moduleVariableCounts = readColumn(reader, nodeCount, "module variable count", (stream, label) => stream.readU32(label));
      const moduleNetCounts = readColumn(reader, nodeCount, "module net count", (stream, label) => stream.readU32(label));
      const moduleVariableBits = readColumn(reader, nodeCount, "module variable bits", (stream, label) => stream.readU64Number(label));
      const moduleNetBits = readColumn(reader, nodeCount, "module net bits", (stream, label) => stream.readU64Number(label));
      const moduleInternalSignalCounts = readColumn(reader, nodeCount, "module internal signal count", (stream, label) => stream.readU32(label));
      const filePathIds = readColumn(reader, nodeCount, "file path id", (stream, label) => stream.readOptionalU32(label));
      const sourceHrefIds = readColumn(reader, nodeCount, "source href id", (stream, label) => stream.readOptionalU32(label));
      const definitionFilePathIds = readColumn(reader, nodeCount, "definition file path id", (stream, label) => stream.readOptionalU32(label));
      const definitionSourceHrefIds = readColumn(reader, nodeCount, "definition source href id", (stream, label) => stream.readOptionalU32(label));
      const lines = readColumn(reader, nodeCount, "line", (stream, label) => stream.readOptionalU32(label));
      const columns = readColumn(reader, nodeCount, "column", (stream, label) => stream.readOptionalU32(label));
      const endLines = readColumn(reader, nodeCount, "end line", (stream, label) => stream.readOptionalU32(label));
      const endColumns = readColumn(reader, nodeCount, "end column", (stream, label) => stream.readOptionalU32(label));
      const definitionLines = readColumn(reader, nodeCount, "definition line", (stream, label) => stream.readOptionalU32(label));
      const definitionColumns = readColumn(reader, nodeCount, "definition column", (stream, label) => stream.readOptionalU32(label));
      const definitionEndLines = readColumn(reader, nodeCount, "definition end line", (stream, label) => stream.readOptionalU32(label));
      const definitionEndColumns = readColumn(reader, nodeCount, "definition end column", (stream, label) => stream.readOptionalU32(label));

      const children = Array.from({ length: nodeCount }, (): number[] => []);
      const depths = new Array<number>(nodeCount).fill(0);
      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        const parent = parents[nodeId];
        if (parent !== null && parent !== undefined) {
          if (parent < 0 || parent >= nodeCount) {
            throw new Error(`viewer-core.bin parent id ${parent} is out of range for node ${nodeId}`);
          }
          children[parent].push(nodeId);
          depths[nodeId] = depths[parent] + 1;
        }
      }

      const rootId = Number(meta.rootId) || 0;
      const nodes = new Array<HierarchyNode>(nodeCount);
      const pathCache = new Array<string | undefined>(nodeCount);

      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        const node = {
          id: nodeId,
          name: stringAt(strings, nameIds[nodeId], "name") || "",
          module: stringAt(strings, moduleIds[nodeId], "module") || "",
          definitionKey: definitionKeys[nodeId],
          parent: parents[nodeId],
          depth: depths[nodeId],
          children: children[nodeId],
          subtreeInstances: subtreeInstances[nodeId],
          subtreeLeaves: subtreeLeaves[nodeId],
          subtreeSignalCount: subtreeSignalCounts[nodeId],
          subtreeInternalSignalCount: subtreeInternalSignalCounts[nodeId],
          subtreeVariableBits: subtreeVariableBits[nodeId],
          subtreeNetBits: subtreeNetBits[nodeId],
          subtreeSignalBits: subtreeVariableBits[nodeId] + subtreeNetBits[nodeId],
          moduleVariableCount: moduleVariableCounts[nodeId],
          moduleNetCount: moduleNetCounts[nodeId],
          moduleSignalCount: moduleVariableCounts[nodeId] + moduleNetCounts[nodeId],
          moduleVariableBits: moduleVariableBits[nodeId],
          moduleNetBits: moduleNetBits[nodeId],
          moduleSignalBits: moduleVariableBits[nodeId] + moduleNetBits[nodeId],
          moduleInternalSignalCount: moduleInternalSignalCounts[nodeId],
          filePath: stringAt(strings, filePathIds[nodeId], "file path"),
          sourceHref: stringAt(strings, sourceHrefIds[nodeId], "source href"),
          definitionFilePath: stringAt(strings, definitionFilePathIds[nodeId], "definition file path"),
          definitionSourceHref: stringAt(strings, definitionSourceHrefIds[nodeId], "definition source href"),
          line: lines[nodeId],
          column: columns[nodeId],
          endLine: endLines[nodeId],
          endColumn: endColumns[nodeId],
          definitionLine: definitionLines[nodeId],
          definitionColumn: definitionColumns[nodeId],
          definitionEndLine: definitionEndLines[nodeId],
          definitionEndColumn: definitionEndColumns[nodeId]
        } as HierarchyNode;
        nodes[nodeId] = node;
      }

      for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
        defineLazyNodePath(nodes[nodeId], nodeId, nodes, rootId, pathCache);
      }

      return {
        title: typeof meta.title === "string" ? meta.title : "",
        builtAtUnixMs: Number(meta.builtAtUnixMs) || 0,
        debugUiLabels: !!meta.debugUiLabels,
        rootId,
        defaultMetric: typeof meta.defaultMetric === "string" ? meta.defaultMetric : "instances",
        analysisDefinitions: null,
        analysisFile: typeof meta.analysisFile === "string" ? meta.analysisFile : null,
        schematic: decodeSchematicMetadata(meta.schematic),
        nodes
      };
    }

    export function decodeAnalysisBundle(buffer: ArrayBuffer): AnalysisDefinition[] {
      const reader = createBinaryReader(buffer);
      const magic = reader.readMagic("viewer-analysis.bin");
      if (magic !== ANALYSIS_BUNDLE_MAGIC) {
        throw new Error(`viewer-analysis.bin has unsupported magic '${magic}'`);
      }
      const version = reader.readU32("viewer-analysis.bin version");
      if (version !== BUNDLE_FORMAT_VERSION) {
        throw new Error(`viewer-analysis.bin has unsupported version ${version}`);
      }
      const strings = reader.readStringTable("viewer-analysis.bin");
      const definitionCount = reader.readU32("viewer-analysis.bin definition count");
      const definitions = new Array<AnalysisDefinition>(definitionCount);
      for (let definitionIndex = 0; definitionIndex < definitionCount; definitionIndex += 1) {
        const definitionKey = reader.readU64Key("definition key");
        const statCount = reader.readU32("signal stat count");
        const signalStats = new Array<DefinitionSignalStat>(statCount);
        for (let statIndex = 0; statIndex < statCount; statIndex += 1) {
          const signalNameId = reader.readU32("signal name id");
          const signalKindId = reader.readU32("signal kind id");
          signalStats[statIndex] = {
            signalName: stringAt(strings, signalNameId, "signal name") || "",
            signalKind: stringAt(strings, signalKindId, "signal kind") || "",
            signalCount: reader.readU32("signal count"),
            totalBits: reader.readU64Number("total bits")
          };
        }
        definitions[definitionIndex] = {
          definitionKey,
          signalStats
        };
      }
      return definitions;
    }
