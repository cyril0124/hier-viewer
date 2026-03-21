#pragma once

#include "model.h"

namespace hier {

CompiledViewerConfig compileViewerConfig(const ViewerConfig& config);
bool shouldExcludeModuleFast(const std::string& moduleName,
                             const CompiledViewerConfig& config);
size_t hierarchyDepth(const std::string& path);

} // namespace hier
