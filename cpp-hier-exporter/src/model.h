#pragma once

#include <cstdint>
#include <optional>
#include <regex>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace hier {

struct ViewerConfig {
    bool compressPrefix = true;
    std::optional<size_t> maxDepth;
    std::vector<std::string> excludeWildcards;
    std::vector<std::string> excludeRegexes;
};

struct CompiledViewerConfig {
    bool compressPrefix = true;
    std::optional<size_t> maxDepth;
    std::vector<std::string> excludeWildcards;
    std::vector<std::regex> excludeRegexes;
};

struct ModuleMetrics {
    size_t portCount = 0;
    size_t logicCount = 0;
    size_t regCount = 0;
    size_t wireCount = 0;
    size_t variableCount = 0;
    size_t netCount = 0;
    size_t signalCount = 0;
    uint64_t variableBits = 0;
    uint64_t netBits = 0;
    uint64_t signalBits = 0;
};

struct DefinitionSignalStatSummary {
    std::string signalName;
    std::string signalKind;
    size_t signalCount = 0;
    uint64_t totalBits = 0;
};

struct DefinitionSignalSummary {
    size_t variableCount = 0;
    size_t netCount = 0;
    size_t signalCount = 0;
    uint64_t variableBits = 0;
    uint64_t netBits = 0;
    uint64_t signalBits = 0;
    size_t internalSignalCount = 0;
    size_t genSignalCount = 0;
    std::vector<DefinitionSignalStatSummary> signalStats;
};

struct HierarchyEntry {
    std::string path;
    std::string module;
    std::string filePath;
    std::optional<size_t> line;
    std::optional<size_t> column;
    std::optional<size_t> endLine;
    std::optional<size_t> endColumn;
    std::string definitionFilePath;
    std::optional<size_t> definitionLine;
    std::optional<size_t> definitionColumn;
    std::optional<size_t> definitionEndLine;
    std::optional<size_t> definitionEndColumn;
    size_t modulePortCount = 0;
    size_t moduleLogicCount = 0;
    size_t moduleRegCount = 0;
    size_t moduleWireCount = 0;
    size_t moduleVariableCount = 0;
    size_t moduleNetCount = 0;
    size_t moduleSignalCount = 0;
    uint64_t moduleVariableBits = 0;
    uint64_t moduleNetBits = 0;
    uint64_t moduleSignalBits = 0;
    size_t moduleInternalSignalCount = 0;
    size_t moduleGenSignalCount = 0;
};

struct InstanceMetadata {
    std::string path;
    std::string module;
    std::optional<uint64_t> definitionKey;
    std::string filePath;
    std::optional<size_t> line;
    std::optional<size_t> column;
    std::optional<size_t> endLine;
    std::optional<size_t> endColumn;
    std::string definitionFilePath;
    std::optional<size_t> definitionLine;
    std::optional<size_t> definitionColumn;
    std::optional<size_t> definitionEndLine;
    std::optional<size_t> definitionEndColumn;
    ModuleMetrics definitionShape;
};

struct HierarchyNode {
    std::string name;
    std::string module;
    std::vector<HierarchyNode> children;
};

struct CollectedHierarchy {
    std::vector<std::pair<std::string, std::string>> hierarchyData;
    std::vector<HierarchyEntry> hierarchyEntries;
    std::vector<InstanceMetadata> instanceMetadata;
    std::vector<std::pair<uint64_t, DefinitionSignalSummary>> definitionSignalSummaries;
};

enum class OutputMode {
    Tree,
    Dir,
    Plain,
    Csv,
    Sqlite,
};

struct CliOptions {
    ViewerConfig viewerConfig;
    std::optional<std::string> outputPath;
    OutputMode mode = OutputMode::Csv;
};

} // namespace hier
