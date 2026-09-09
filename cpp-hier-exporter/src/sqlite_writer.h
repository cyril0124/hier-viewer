#pragma once

#include <ostream>
#include <vector>

#include "model.h"

namespace slang::ast { class Compilation; }

namespace hier {

void generateCsvHierarchy(const std::vector<HierarchyEntry>& hierarchyData,
                          std::ostream& output,
                          const ViewerConfig& config);

void generateSqliteHierarchy(
    const std::vector<HierarchyEntry>& hierarchyData,
    const std::vector<InstanceMetadata>& instanceMetadata,
    const std::vector<std::pair<uint64_t, DefinitionSignalSummary>>& definitionSignalSummaries,
    const std::vector<std::string>& dependencies,
    slang::ast::Compilation& compilation,
    const std::string& outputPath,
    const ViewerConfig& config);

} // namespace hier
