#include "exporter.h"

#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>

#include "slang/ast/Compilation.h"
#include "slang/ast/Scope.h"
#include "slang/ast/symbols/CompilationUnitSymbols.h"
#include "slang/ast/symbols/InstanceSymbols.h"
#include "slang/ast/symbols/PortSymbols.h"
#include "slang/ast/symbols/VariableSymbols.h"
#include "slang/ast/types/AllTypes.h"
#include "slang/ast/types/NetType.h"
#include "slang/text/SourceManager.h"

namespace hier {

using namespace slang;
using namespace slang::ast;

namespace {

struct SourceLocationInfo {
    std::string filePath;
    std::optional<size_t> line;
    std::optional<size_t> column;
};

struct SourceRangeEnd {
    std::optional<size_t> endLine;
    std::optional<size_t> endColumn;
};

SourceLocationInfo originalLocationDetails(const SourceManager& sourceManager,
                                           SourceLocation location) {
    SourceLocationInfo info;
    if (location == SourceLocation::NoLocation) {
        return info;
    }

    const auto original = sourceManager.getFullyOriginalLoc(location);
    if (original == SourceLocation::NoLocation) {
        return info;
    }

    info.filePath = sourceManager.getFullPath(original.buffer()).string();
    info.line = sourceManager.getLineNumber(original);
    info.column = sourceManager.getColumnNumber(original);
    return info;
}

SourceRangeEnd originalRangeEnd(const SourceManager& sourceManager, const SourceRange& range) {
    SourceRangeEnd info;
    if (range.start() == SourceLocation::NoLocation) {
        return info;
    }

    const auto original = sourceManager.getFullyOriginalRange(range);
    if (original.start() == SourceLocation::NoLocation) {
        return info;
    }

    info.endLine = sourceManager.getLineNumber(original.end());
    info.endColumn = sourceManager.getColumnNumber(original.end());
    return info;
}

uint64_t symbolBitWidth(const ValueSymbol& symbol) {
    try {
        return symbol.getType().getBitstreamWidth();
    } catch (const std::exception&) {
        return 0;
    }
}

const Type& unwrapSignalBaseType(const Type& type) {
    const Type* current = &type.getCanonicalType();
    for (;;) {
        if (current->kind == SymbolKind::PackedArrayType) {
            current = &current->as<PackedArrayType>().elementType.getCanonicalType();
            continue;
        }
        if (current->kind == SymbolKind::FixedSizeUnpackedArrayType) {
            current = &current->as<FixedSizeUnpackedArrayType>().elementType.getCanonicalType();
            continue;
        }
        if (current->kind == SymbolKind::DynamicArrayType) {
            current = &current->as<DynamicArrayType>().elementType.getCanonicalType();
            continue;
        }
        if (current->kind == SymbolKind::AssociativeArrayType) {
            current = &current->as<AssociativeArrayType>().elementType.getCanonicalType();
            continue;
        }
        if (current->kind == SymbolKind::QueueType) {
            current = &current->as<QueueType>().elementType.getCanonicalType();
            continue;
        }
        if (current->kind == SymbolKind::DPIOpenArrayType) {
            current = &current->as<DPIOpenArrayType>().elementType.getCanonicalType();
            continue;
        }
        return *current;
    }
}

void classifyShapeSymbol(const Symbol& symbol, ModuleMetrics& metrics) {
    if (symbol.kind == SymbolKind::Net) {
        const auto& net = symbol.as<NetSymbol>();
        if (net.netType.netKind == NetType::Wire) {
            metrics.wireCount += 1;
        }
        return;
    }

    if (!VariableSymbol::isKind(symbol.kind)) {
        return;
    }

    const auto& baseType = unwrapSignalBaseType(symbol.as<ValueSymbol>().getType());
    if (baseType.kind != SymbolKind::ScalarType) {
        return;
    }

    const auto scalarKind = baseType.as<ScalarType>().scalarKind;
    if (scalarKind == ScalarType::Logic) {
        metrics.logicCount += 1;
    } else if (scalarKind == ScalarType::Reg) {
        metrics.regCount += 1;
    }
}

std::unordered_set<const Symbol*> collectPortInternalSymbols(const InstanceBodySymbol& body,
                                                             ModuleMetrics* shapeMetrics) {
    std::unordered_set<const Symbol*> result;
    for (const Symbol* portSymbol : body.getPortList()) {
        if (!portSymbol) {
            continue;
        }

        if (shapeMetrics) {
            shapeMetrics->portCount += 1;
        }

        if (portSymbol->kind == SymbolKind::Port) {
            const auto& port = portSymbol->as<PortSymbol>();
            if (port.internalSymbol) {
                result.insert(port.internalSymbol);
                if (shapeMetrics) {
                    classifyShapeSymbol(*port.internalSymbol, *shapeMetrics);
                }
            }
            continue;
        }

        if (portSymbol->kind == SymbolKind::MultiPort) {
            const auto& multi = portSymbol->as<MultiPortSymbol>();
            if (shapeMetrics && !multi.ports.empty()) {
                shapeMetrics->portCount += multi.ports.size() - 1;
            }
            for (const PortSymbol* port : multi.ports) {
                if (!port || !port->internalSymbol) {
                    continue;
                }
                if (result.insert(port->internalSymbol).second && shapeMetrics) {
                    classifyShapeSymbol(*port->internalSymbol, *shapeMetrics);
                }
            }
        }
    }
    return result;
}

ModuleMetrics collectDefinitionShape(const InstanceBodySymbol& body) {
    ModuleMetrics metrics;
    auto portInternals = collectPortInternalSymbols(body, &metrics);

    std::function<void(const Scope&)> visitScope = [&](const Scope& scope) {
        for (const Symbol& member : scope.members()) {
            if (member.kind == SymbolKind::Instance || member.kind == SymbolKind::InstanceArray ||
                member.kind == SymbolKind::Port || member.kind == SymbolKind::MultiPort ||
                member.kind == SymbolKind::InterfacePort) {
                continue;
            }

            if ((VariableSymbol::isKind(member.kind) || member.kind == SymbolKind::Net) &&
                !portInternals.count(&member)) {
                classifyShapeSymbol(member, metrics);
            }

            if (member.isScope()) {
                visitScope(member.as<Scope>());
            }
        }
    };

    visitScope(body);
    return metrics;
}

DefinitionSignalSummary collectDefinitionSignals(const InstanceBodySymbol& body) {
    DefinitionSignalSummary summary;
    const auto portInternals = collectPortInternalSymbols(body, nullptr);
    std::map<std::pair<std::string, std::string>, std::pair<size_t, uint64_t>> signalStats;

    std::function<void(const Scope&)> visitScope = [&](const Scope& scope) {
        for (const Symbol& member : scope.members()) {
            if (member.kind == SymbolKind::Instance || member.kind == SymbolKind::InstanceArray) {
                continue;
            }
            if (member.kind == SymbolKind::Port || member.kind == SymbolKind::MultiPort ||
                member.kind == SymbolKind::InterfacePort) {
                continue;
            }

            if (VariableSymbol::isKind(member.kind)) {
                const auto& symbol = member.as<ValueSymbol>();
                const uint64_t bits = symbolBitWidth(symbol);
                summary.variableCount += 1;
                summary.variableBits += bits;
                const bool isPort = portInternals.count(&member) != 0;
                if (!isPort) {
                    summary.internalSignalCount += 1;
                    if (member.name.starts_with("_GEN")) {
                        summary.genSignalCount += 1;
                    }
                    auto& aggregate =
                        signalStats[{std::string(member.name), std::string("variable")}];
                    aggregate.first += 1;
                    aggregate.second += bits;
                }
                continue;
            }

            if (member.kind == SymbolKind::Net) {
                const auto& symbol = member.as<ValueSymbol>();
                const uint64_t bits = symbolBitWidth(symbol);
                summary.netCount += 1;
                summary.netBits += bits;
                const bool isPort = portInternals.count(&member) != 0;
                if (!isPort) {
                    summary.internalSignalCount += 1;
                    if (member.name.starts_with("_GEN")) {
                        summary.genSignalCount += 1;
                    }
                    auto& aggregate =
                        signalStats[{std::string(member.name), std::string("net")}];
                    aggregate.first += 1;
                    aggregate.second += bits;
                }
                continue;
            }

            if (member.isScope()) {
                visitScope(member.as<Scope>());
            }
        }
    };

    visitScope(body);
    summary.signalCount = summary.variableCount + summary.netCount;
    summary.signalBits = summary.variableBits + summary.netBits;

    for (const auto& [key, value] : signalStats) {
        summary.signalStats.push_back(DefinitionSignalStatSummary{
            .signalName = key.first,
            .signalKind = key.second,
            .signalCount = value.first,
            .totalBits = value.second,
        });
    }
    return summary;
}

class HierarchyCollector {
public:
    explicit HierarchyCollector(const SourceManager& sourceManager) : sourceManager(sourceManager) {}

    CollectedHierarchy collect(Compilation& compilation) {
        for (const InstanceSymbol* topInstance : compilation.getRoot().topInstances) {
            if (topInstance) {
                collectInstance(*topInstance);
            }
        }
        finalizeEntries();
        return {
            .hierarchyData = std::move(hierarchyData),
            .hierarchyEntries = std::move(hierarchyEntries),
            .instanceMetadata = std::move(instanceMetadata),
            .definitionSignalSummaries = orderedSignalSummaries(),
        };
    }

private:
    const SourceManager& sourceManager;
    std::vector<std::pair<std::string, std::string>> hierarchyData;
    std::vector<HierarchyEntry> hierarchyEntries;
    std::vector<InstanceMetadata> instanceMetadata;
    struct CachedDefinition {
        ModuleMetrics shape;
        DefinitionSignalSummary signals;
    };

    std::unordered_map<const InstanceBodySymbol*, uint64_t> definitionKeys;
    std::vector<CachedDefinition> definitionCache;

    std::vector<std::pair<uint64_t, DefinitionSignalSummary>> orderedSignalSummaries() {
        std::vector<std::pair<uint64_t, DefinitionSignalSummary>> result;
        result.reserve(definitionCache.size());
        for (size_t index = 0; index < definitionCache.size(); ++index) {
            result.emplace_back(index + 1, std::move(definitionCache[index].signals));
        }
        return result;
    }

    void finalizeEntries() {
        hierarchyEntries.clear();
        hierarchyEntries.reserve(instanceMetadata.size());

        for (const auto& instance : instanceMetadata) {
            const auto& signalSummary =
                definitionCache.at(instance.definitionKey.value() - 1).signals;

            hierarchyEntries.push_back(HierarchyEntry{
                .path = instance.path,
                .module = instance.module,
                .filePath = instance.filePath,
                .line = instance.line,
                .column = instance.column,
                .endLine = instance.endLine,
                .endColumn = instance.endColumn,
                .definitionFilePath = instance.definitionFilePath,
                .definitionLine = instance.definitionLine,
                .definitionColumn = instance.definitionColumn,
                .definitionEndLine = instance.definitionEndLine,
                .definitionEndColumn = instance.definitionEndColumn,
                .modulePortCount = instance.definitionShape.portCount,
                .moduleLogicCount = instance.definitionShape.logicCount,
                .moduleRegCount = instance.definitionShape.regCount,
                .moduleWireCount = instance.definitionShape.wireCount,
                .moduleVariableCount = signalSummary.variableCount,
                .moduleNetCount = signalSummary.netCount,
                .moduleSignalCount = signalSummary.signalCount,
                .moduleVariableBits = signalSummary.variableBits,
                .moduleNetBits = signalSummary.netBits,
                .moduleSignalBits = signalSummary.signalBits,
                .moduleInternalSignalCount = signalSummary.internalSignalCount,
                .moduleGenSignalCount = signalSummary.genSignalCount,
            });
        }
    }

    void collectChildInstances(const Scope& scope) {
        for (const Symbol& member : scope.members()) {
            if (member.kind == SymbolKind::Instance) {
                collectInstance(member.as<InstanceSymbol>());
                continue;
            }

            if (member.isScope()) {
                collectChildInstances(member.as<Scope>());
            }
        }
    }

    void collectInstance(const InstanceSymbol& node) {
        appendInstance(node);
        collectChildInstances(node.body);
    }

    void appendInstance(const InstanceSymbol& node) {
        const std::string hierPath = node.getHierarchicalPath();
        const auto& definition = node.getDefinition();
        const std::string moduleName = std::string(definition.name);
        hierarchyData.push_back({hierPath, moduleName});

        const auto instanceLoc = originalLocationDetails(sourceManager, node.location);
        SourceRangeEnd instanceEnd;
        if (const auto* syntax = node.getSyntax()) {
            instanceEnd = originalRangeEnd(sourceManager, syntax->sourceRange());
        }

        const auto definitionLoc = originalLocationDetails(sourceManager, definition.location);
        SourceRangeEnd definitionEnd;
        if (const auto* syntax = definition.getSyntax()) {
            definitionEnd = originalRangeEnd(sourceManager, syntax->sourceRange());
        }

        const auto* body = node.getCanonicalBody();
        if (!body) {
            body = &node.body;
        }

        // Keys are one-based cache indices local to this export, not source identities.
        const auto [keyIt, inserted] = definitionKeys.try_emplace(body, definitionCache.size() + 1);
        const uint64_t definitionKey = keyIt->second;
        if (inserted) {
            definitionCache.push_back({collectDefinitionShape(*body), collectDefinitionSignals(*body)});
        }
        const auto& definitionShape = definitionCache.at(definitionKey - 1).shape;

        instanceMetadata.push_back(InstanceMetadata{
            .path = hierPath,
            .module = moduleName,
            .definitionKey = definitionKey,
            .filePath = instanceLoc.filePath,
            .line = instanceLoc.line,
            .column = instanceLoc.column,
            .endLine = instanceEnd.endLine,
            .endColumn = instanceEnd.endColumn,
            .definitionFilePath = definitionLoc.filePath,
            .definitionLine = definitionLoc.line,
            .definitionColumn = definitionLoc.column,
            .definitionEndLine = definitionEnd.endLine,
            .definitionEndColumn = definitionEnd.endColumn,
            .definitionShape = definitionShape,
        });
    }
};

} // namespace

CollectedHierarchy collectHierarchy(Compilation& compilation,
                                   const SourceManager& sourceManager) {
    HierarchyCollector collector(sourceManager);
    return collector.collect(compilation);
}

} // namespace hier
