#include "schematic_worker.h"

#include <filesystem>
#include <iostream>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>

#include <sqlite3.h>

#include "logger.h"
#include "schematic.h"

namespace hier {
namespace {

using Database = std::unique_ptr<sqlite3, decltype(&sqlite3_close_v2)>;
using Statement = std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)>;

void checkSqlite(sqlite3* db, int result) {
    if (result != SQLITE_OK && result != SQLITE_DONE && result != SQLITE_ROW) {
        throw std::runtime_error(sqlite3_errmsg(db));
    }
}

Database openDatabase(const std::filesystem::path& path, int flags) {
    sqlite3* handle = nullptr;
    const int result = sqlite3_open_v2(path.string().c_str(), &handle, flags, nullptr);
    Database db(handle, sqlite3_close_v2);
    checkSqlite(db.get(), result);
    return db;
}

void exec(sqlite3* db, const char* sql) {
    checkSqlite(db, sqlite3_exec(db, sql, nullptr, nullptr, nullptr));
}

Statement prepare(sqlite3* db, const char* sql) {
    sqlite3_stmt* handle = nullptr;
    const int result = sqlite3_prepare_v2(db, sql, -1, &handle, nullptr);
    Statement statement(handle, sqlite3_finalize);
    checkSqlite(db, result);
    return statement;
}

void closeDatabase(Database& db) {
    checkSqlite(db.get(), sqlite3_close(db.get()));
    db.release();
}

void requireDistinctPaths(const std::filesystem::path& source,
                          const std::filesystem::path& destination) {
    // Canonical paths catch symlinks and lexical aliases; equivalent also catches
    // hard links. Run this before every output mutation, including initialization.
    if (std::filesystem::weakly_canonical(source) ==
            std::filesystem::weakly_canonical(destination) ||
        (std::filesystem::exists(destination) && std::filesystem::equivalent(source, destination))) {
        throw std::runtime_error("schematic worker source and output must be different files");
    }
}

std::set<std::string> readAllowedPaths(const std::filesystem::path& source) {
    auto db = openDatabase(source, SQLITE_OPEN_READONLY);
    auto statement = prepare(db.get(), "SELECT path FROM instances");
    std::set<std::string> paths;
    int result;
    while ((result = sqlite3_step(statement.get())) == SQLITE_ROW) {
        const auto* text = sqlite3_column_text(statement.get(), 0);
        if (!text) {
            throw std::runtime_error("hierarchy instances contains a NULL path");
        }
        paths.emplace(reinterpret_cast<const char*>(text), sqlite3_column_bytes(statement.get(), 0));
    }
    checkSqlite(db.get(), result);
    return paths;
}

void initializeOutput(const std::filesystem::path& destination,
                      const std::set<std::string>& allowedPaths) {
    std::filesystem::remove(destination);
    auto db = openDatabase(destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    exec(db.get(), "BEGIN; CREATE TABLE instances(path TEXT PRIMARY KEY) WITHOUT ROWID;");
    {
        auto statement = prepare(db.get(), "INSERT INTO instances VALUES(?1)");
        for (const auto& path : allowedPaths) {
            checkSqlite(db.get(), sqlite3_bind_text(statement.get(), 1, path.c_str(),
                                                   static_cast<int>(path.size()), SQLITE_STATIC));
            checkSqlite(db.get(), sqlite3_step(statement.get()));
            checkSqlite(db.get(), sqlite3_reset(statement.get()));
        }
    }
    exec(db.get(), "COMMIT");
    closeDatabase(db);
}

void writeScope(const std::filesystem::path& destination, slang::ast::Compilation& compilation,
                const std::set<std::string>& allowedPaths, const std::string& scope) {
    auto db = openDatabase(destination, SQLITE_OPEN_READWRITE);
    // Closing the connection rolls back on any exception. Readers only receive
    // OK after commit and close, so they never observe a partially written graph.
    exec(db.get(),
         "BEGIN;"
         "DROP TABLE IF EXISTS schematic_endpoints;"
         "DROP TABLE IF EXISTS schematic_nets;"
         "DROP TABLE IF EXISTS schematic_ports;"
         "DROP TABLE IF EXISTS schematic_nodes;"
         "DROP TABLE IF EXISTS schematic_scopes;"
         "DROP TABLE IF EXISTS schematic_metadata;");
    writeSchematic(db.get(), compilation, allowedPaths, scope);
    exec(db.get(), "COMMIT");
    closeDatabase(db);
}

} // namespace

void runSchematicWorker(slang::ast::Compilation& compilation,
                        const std::string& hierarchyPath, const std::string& outputPath) {
    const auto source = std::filesystem::absolute(hierarchyPath);
    const auto destination = std::filesystem::absolute(outputPath);
    requireDistinctPaths(source, destination);
    const auto allowedPaths = readAllowedPaths(source);
    initializeOutput(destination, allowedPaths);
    std::cout << "HIER_SCHEMATIC_READY\n" << std::flush;

    std::string scope;
    while (std::getline(std::cin, scope)) {
        try {
            if (scope.empty() || scope.find('\r') != std::string::npos ||
                scope.find('\0') != std::string::npos) {
                throw std::runtime_error("schematic worker requires a non-empty scope without CR or NUL");
            }
            if (!allowedPaths.contains(scope)) {
                throw std::runtime_error("schematic scope not found in exported hierarchy: " + scope);
            }
            requireDistinctPaths(source, destination);
            writeScope(destination, compilation, allowedPaths, scope);
            std::cout << "HIER_SCHEMATIC_OK\n" << std::flush;
        } catch (const std::exception& error) {
            logError("schematic-worker", error.what());
            std::cout << "HIER_SCHEMATIC_ERROR\n" << std::flush;
        }
    }
    if (std::cin.bad()) {
        throw std::runtime_error("failed reading schematic worker requests");
    }
}

} // namespace hier
