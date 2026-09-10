#pragma once

#include <string>

namespace slang::ast { class Compilation; }

namespace hier {

// Serves newline-delimited scope requests until stdin reaches EOF. The source
// hierarchy is read-only; each OK acknowledges a committed, closed output DB.
void runSchematicWorker(slang::ast::Compilation& compilation,
                        const std::string& hierarchyPath, const std::string& outputPath);

} // namespace hier
