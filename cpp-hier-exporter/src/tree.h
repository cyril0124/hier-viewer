#pragma once

#include <ostream>
#include <string>
#include <vector>

#include "model.h"

namespace hier {

HierarchyNode* buildHierarchyTree(const std::vector<std::pair<std::string, std::string>>& instances,
                                  HierarchyNode& storage);
HierarchyNode compressTree(const HierarchyNode& node);
void generateAsciiTree(const std::vector<std::pair<std::string, std::string>>& hierarchyData,
                       std::ostream& output,
                       const ViewerConfig& config);
void generatePlainHierarchy(const std::vector<std::pair<std::string, std::string>>& hierarchyData,
                            std::ostream& output,
                            const ViewerConfig& config);
void generateHierarchyDirectory(
    const std::vector<std::pair<std::string, std::string>>& hierarchyData,
    const std::string& outputDir,
    const ViewerConfig& config);

} // namespace hier
