#pragma once

#include "model.h"

namespace slang {
class SourceManager;
}

namespace slang::ast {
class Compilation;
}

namespace hier {

CollectedHierarchy collectHierarchy(slang::ast::Compilation& compilation,
                                   const slang::SourceManager& sourceManager);

} // namespace hier
