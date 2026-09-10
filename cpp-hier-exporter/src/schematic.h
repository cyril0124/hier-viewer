#pragma once

#include <optional>
#include <set>
#include <string>

struct sqlite3;
namespace slang::ast { class Compilation; }

namespace hier {

// Writes all allowed scopes, or one exact scope, inside the caller's transaction.
// Throws if the requested scope is absent or excluded by hierarchy filters.
void writeSchematic(sqlite3* db, slang::ast::Compilation& compilation,
                    const std::set<std::string>& allowedPaths,
                    const std::optional<std::string>& selectedScope);

} // namespace hier
