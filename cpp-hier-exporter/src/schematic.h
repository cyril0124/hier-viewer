#pragma once

#include <set>
#include <string>

struct sqlite3;
namespace slang::ast { class Compilation; }

namespace hier {

// Writes one scope at a time inside the caller's SQLite transaction.
void writeSchematic(sqlite3* db, slang::ast::Compilation& compilation,
                    const std::set<std::string>& allowedPaths);

} // namespace hier
