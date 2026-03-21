#include "sqlite_writer.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

#include <sqlite3.h>

#include "filters.h"

namespace fs = std::filesystem;

namespace hier {

namespace {

class Statement {
public:
    Statement(sqlite3* db, const char* sql) {
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
            throw std::runtime_error(sqlite3_errmsg(db));
        }
    }

    ~Statement() {
        if (stmt) {
            sqlite3_finalize(stmt);
        }
    }

    sqlite3_stmt* get() { return stmt; }

    void reset() {
        sqlite3_reset(stmt);
        sqlite3_clear_bindings(stmt);
    }

private:
    sqlite3_stmt* stmt = nullptr;
};

void checkSqlite(int code, sqlite3* db, const std::string& context) {
    if (code != SQLITE_OK && code != SQLITE_DONE && code != SQLITE_ROW) {
        throw std::runtime_error(context + ": " + sqlite3_errmsg(db));
    }
}

void exec(sqlite3* db, const char* sql) {
    char* error = nullptr;
    const int code = sqlite3_exec(db, sql, nullptr, nullptr, &error);
    if (code != SQLITE_OK) {
        std::string message = error ? error : sqlite3_errmsg(db);
        sqlite3_free(error);
        throw std::runtime_error(message);
    }
}

std::string csvEscape(const std::string& value) {
    bool needsQuotes = false;
    std::string escaped;
    escaped.reserve(value.size() + 4);
    for (char ch : value) {
        if (ch == '"' || ch == ',' || ch == '\n' || ch == '\r') {
            needsQuotes = true;
        }
        if (ch == '"') {
            escaped += "\"\"";
        } else {
            escaped += ch;
        }
    }
    if (!needsQuotes) {
        return escaped;
    }
    return "\"" + escaped + "\"";
}

template<typename T>
void bindOptionalInt(sqlite3_stmt* stmt, int index, const std::optional<T>& value) {
    if (value) {
        sqlite3_bind_int64(stmt, index, static_cast<sqlite3_int64>(*value));
    } else {
        sqlite3_bind_null(stmt, index);
    }
}

void bindText(sqlite3_stmt* stmt, int index, const std::string& value) {
    sqlite3_bind_text(stmt, index, value.c_str(), -1, SQLITE_TRANSIENT);
}

void bindUInt(sqlite3_stmt* stmt, int index, uint64_t value) {
    sqlite3_bind_int64(stmt, index, static_cast<sqlite3_int64>(value));
}

void bindSize(sqlite3_stmt* stmt, int index, size_t value) {
    sqlite3_bind_int64(stmt, index, static_cast<sqlite3_int64>(value));
}

} // namespace

void generateCsvHierarchy(const std::vector<HierarchyEntry>& hierarchyData,
                          std::ostream& output,
                          const ViewerConfig& config) {
    const auto compiled = compileViewerConfig(config);
    std::vector<HierarchyEntry> filtered;
    for (const auto& entry : hierarchyData) {
        if (shouldExcludeModuleFast(entry.module, compiled)) {
            continue;
        }
        if (compiled.maxDepth && hierarchyDepth(entry.path) >= *compiled.maxDepth) {
            continue;
        }
        filtered.push_back(entry);
    }

    output
        << "path,module,file_path,line,column,end_line,end_column,definition_file_path,"
           "definition_line,definition_column,definition_end_line,definition_end_column,"
           "module_port_count,module_logic_count,module_reg_count,module_wire_count,"
           "module_variable_count,module_net_count,module_signal_count,module_variable_bits,"
           "module_net_bits,module_signal_bits,module_internal_signal_count,module_gen_signal_count\n";

    std::sort(filtered.begin(), filtered.end(),
              [](const auto& lhs, const auto& rhs) { return lhs.path < rhs.path; });

    auto emitOptional = [&](const std::optional<size_t>& value) {
        return value ? std::to_string(*value) : std::string();
    };

    for (const auto& entry : filtered) {
        output << csvEscape(entry.path) << ',' << csvEscape(entry.module) << ','
               << csvEscape(entry.filePath) << ',' << emitOptional(entry.line) << ','
               << emitOptional(entry.column) << ',' << emitOptional(entry.endLine) << ','
               << emitOptional(entry.endColumn) << ',' << csvEscape(entry.definitionFilePath)
               << ',' << emitOptional(entry.definitionLine) << ','
               << emitOptional(entry.definitionColumn) << ','
               << emitOptional(entry.definitionEndLine) << ','
               << emitOptional(entry.definitionEndColumn) << ',' << entry.modulePortCount << ','
               << entry.moduleLogicCount << ',' << entry.moduleRegCount << ','
               << entry.moduleWireCount << ',' << entry.moduleVariableCount << ','
               << entry.moduleNetCount << ',' << entry.moduleSignalCount << ','
               << entry.moduleVariableBits << ',' << entry.moduleNetBits << ','
               << entry.moduleSignalBits << ',' << entry.moduleInternalSignalCount << ','
               << entry.moduleGenSignalCount << '\n';
    }
}

void generateSqliteHierarchy(
    const std::vector<HierarchyEntry>& hierarchyData,
    const std::vector<InstanceMetadata>& instanceMetadata,
    const std::vector<std::pair<uint64_t, DefinitionSignalSummary>>& definitionSignalSummaries,
    const std::string& outputPath,
    const ViewerConfig& config) {
    const auto compiled = compileViewerConfig(config);

    std::vector<HierarchyEntry> filteredEntries;
    std::set<std::string> allowedPaths;
    for (const auto& entry : hierarchyData) {
        if (shouldExcludeModuleFast(entry.module, compiled)) {
            continue;
        }
        if (compiled.maxDepth && hierarchyDepth(entry.path) >= *compiled.maxDepth) {
            continue;
        }
        filteredEntries.push_back(entry);
        allowedPaths.insert(entry.path);
    }

    std::vector<InstanceMetadata> filteredInstances;
    std::map<uint64_t, InstanceMetadata> definitionRepresentatives;
    std::map<std::string, std::optional<uint64_t>> instanceDefinitionKeys;
    for (const auto& metadata : instanceMetadata) {
        if (!allowedPaths.count(metadata.path)) {
            continue;
        }
        filteredInstances.push_back(metadata);
        instanceDefinitionKeys.emplace(metadata.path, metadata.definitionKey);
        if (metadata.definitionKey && !definitionRepresentatives.count(*metadata.definitionKey)) {
            definitionRepresentatives.emplace(*metadata.definitionKey, metadata);
        }
    }

    std::map<uint64_t, DefinitionSignalSummary> definitionSignalMap;
    for (const auto& [key, summary] : definitionSignalSummaries) {
        definitionSignalMap.emplace(key, summary);
    }

    const fs::path parent = fs::path(outputPath).parent_path();
    if (!parent.empty()) {
        fs::create_directories(parent);
    }
    fs::remove(outputPath);

    sqlite3* db = nullptr;
    if (sqlite3_open(outputPath.c_str(), &db) != SQLITE_OK) {
        const std::string message = db ? sqlite3_errmsg(db) : "failed to open sqlite database";
        if (db) {
            sqlite3_close(db);
        }
        throw std::runtime_error(message);
    }

    try {
        exec(db, "PRAGMA journal_mode=OFF");
        exec(db, "PRAGMA synchronous=OFF");
        exec(db, "PRAGMA temp_store=MEMORY");
        exec(db, "PRAGMA cache_size=-200000");
        exec(db, "BEGIN IMMEDIATE");
        exec(db,
             "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
             "CREATE TABLE instances ("
             "path TEXT PRIMARY KEY,"
             "parent_path TEXT,"
             "instance_name TEXT NOT NULL,"
             "module TEXT NOT NULL,"
             "definition_key INTEGER,"
             "file_path TEXT NOT NULL,"
             "line INTEGER,"
             "column INTEGER,"
             "end_line INTEGER,"
             "end_column INTEGER,"
             "definition_file_path TEXT NOT NULL,"
             "definition_line INTEGER,"
             "definition_column INTEGER,"
             "definition_end_line INTEGER,"
             "definition_end_column INTEGER,"
             "module_port_count INTEGER NOT NULL,"
             "module_logic_count INTEGER NOT NULL,"
             "module_reg_count INTEGER NOT NULL,"
             "module_wire_count INTEGER NOT NULL,"
             "module_variable_count INTEGER NOT NULL,"
             "module_net_count INTEGER NOT NULL,"
             "module_signal_count INTEGER NOT NULL,"
             "module_variable_bits INTEGER NOT NULL,"
             "module_net_bits INTEGER NOT NULL,"
             "module_signal_bits INTEGER NOT NULL,"
             "module_internal_signal_count INTEGER NOT NULL,"
             "module_gen_signal_count INTEGER NOT NULL"
             ");"
             "CREATE TABLE definitions ("
             "definition_key INTEGER PRIMARY KEY,"
             "module TEXT NOT NULL,"
             "definition_file_path TEXT NOT NULL,"
             "definition_line INTEGER,"
             "definition_column INTEGER,"
             "definition_end_line INTEGER,"
             "definition_end_column INTEGER,"
             "module_port_count INTEGER NOT NULL,"
             "module_logic_count INTEGER NOT NULL,"
             "module_reg_count INTEGER NOT NULL,"
             "module_wire_count INTEGER NOT NULL,"
             "module_variable_count INTEGER NOT NULL,"
             "module_net_count INTEGER NOT NULL,"
             "module_signal_count INTEGER NOT NULL,"
             "module_variable_bits INTEGER NOT NULL,"
             "module_net_bits INTEGER NOT NULL,"
             "module_signal_bits INTEGER NOT NULL,"
             "module_internal_signal_count INTEGER NOT NULL,"
             "module_gen_signal_count INTEGER NOT NULL"
             ");"
             "CREATE TABLE definition_signal_stats ("
             "definition_key INTEGER NOT NULL,"
             "signal_name TEXT NOT NULL,"
             "signal_kind TEXT NOT NULL,"
             "signal_count INTEGER NOT NULL,"
             "total_bits INTEGER NOT NULL"
             ");"
             "CREATE INDEX idx_instances_parent_path ON instances(parent_path);"
             "CREATE INDEX idx_instances_module ON instances(module);"
             "CREATE INDEX idx_instances_definition_key ON instances(definition_key);"
             "CREATE INDEX idx_def_signal_stats_definition_key ON definition_signal_stats(definition_key);"
             "CREATE INDEX idx_def_signal_stats_signal_name ON definition_signal_stats(signal_name);");

        Statement metaStmt(db, "INSERT INTO meta(key, value) VALUES(?1, ?2)");
        auto insertMeta = [&](const std::string& key, const std::string& value) {
            metaStmt.reset();
            bindText(metaStmt.get(), 1, key);
            bindText(metaStmt.get(), 2, value);
            checkSqlite(sqlite3_step(metaStmt.get()), db, "failed to insert meta row");
        };
        insertMeta("format", "hier-viewer-sqlite");
        insertMeta("schema_version", "2");
        insertMeta("instance_count", std::to_string(filteredEntries.size()));
        insertMeta("definition_count", std::to_string(definitionRepresentatives.size()));

        Statement instanceStmt(
            db,
            "INSERT INTO instances("
            "path,parent_path,instance_name,module,definition_key,file_path,line,column,end_line,end_column,"
            "definition_file_path,definition_line,definition_column,definition_end_line,definition_end_column,"
            "module_port_count,module_logic_count,module_reg_count,module_wire_count,module_variable_count,"
            "module_net_count,module_signal_count,module_variable_bits,module_net_bits,module_signal_bits,"
            "module_internal_signal_count,module_gen_signal_count"
            ") VALUES("
            "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)");

        std::sort(filteredEntries.begin(), filteredEntries.end(),
                  [](const auto& lhs, const auto& rhs) { return lhs.path < rhs.path; });
        for (const auto& entry : filteredEntries) {
            instanceStmt.reset();
            const auto parentPos = entry.path.find_last_of('.');
            const std::string parentPath =
                parentPos == std::string::npos ? std::string() : entry.path.substr(0, parentPos);
            const std::string instanceName =
                parentPos == std::string::npos ? entry.path : entry.path.substr(parentPos + 1);
            bindText(instanceStmt.get(), 1, entry.path);
            if (parentPath.empty()) {
                sqlite3_bind_null(instanceStmt.get(), 2);
            } else {
                bindText(instanceStmt.get(), 2, parentPath);
            }
            bindText(instanceStmt.get(), 3, instanceName);
            bindText(instanceStmt.get(), 4, entry.module);
            const auto keyIt = instanceDefinitionKeys.find(entry.path);
            if (keyIt != instanceDefinitionKeys.end() && keyIt->second) {
                bindUInt(instanceStmt.get(), 5, *keyIt->second);
            } else {
                sqlite3_bind_null(instanceStmt.get(), 5);
            }
            bindText(instanceStmt.get(), 6, entry.filePath);
            bindOptionalInt(instanceStmt.get(), 7, entry.line);
            bindOptionalInt(instanceStmt.get(), 8, entry.column);
            bindOptionalInt(instanceStmt.get(), 9, entry.endLine);
            bindOptionalInt(instanceStmt.get(), 10, entry.endColumn);
            bindText(instanceStmt.get(), 11, entry.definitionFilePath);
            bindOptionalInt(instanceStmt.get(), 12, entry.definitionLine);
            bindOptionalInt(instanceStmt.get(), 13, entry.definitionColumn);
            bindOptionalInt(instanceStmt.get(), 14, entry.definitionEndLine);
            bindOptionalInt(instanceStmt.get(), 15, entry.definitionEndColumn);
            bindSize(instanceStmt.get(), 16, entry.modulePortCount);
            bindSize(instanceStmt.get(), 17, entry.moduleLogicCount);
            bindSize(instanceStmt.get(), 18, entry.moduleRegCount);
            bindSize(instanceStmt.get(), 19, entry.moduleWireCount);
            bindSize(instanceStmt.get(), 20, entry.moduleVariableCount);
            bindSize(instanceStmt.get(), 21, entry.moduleNetCount);
            bindSize(instanceStmt.get(), 22, entry.moduleSignalCount);
            bindUInt(instanceStmt.get(), 23, entry.moduleVariableBits);
            bindUInt(instanceStmt.get(), 24, entry.moduleNetBits);
            bindUInt(instanceStmt.get(), 25, entry.moduleSignalBits);
            bindSize(instanceStmt.get(), 26, entry.moduleInternalSignalCount);
            bindSize(instanceStmt.get(), 27, entry.moduleGenSignalCount);
            checkSqlite(sqlite3_step(instanceStmt.get()), db, "failed to insert instance row");
        }

        Statement definitionStmt(
            db,
            "INSERT INTO definitions("
            "definition_key,module,definition_file_path,definition_line,definition_column,definition_end_line,definition_end_column,"
            "module_port_count,module_logic_count,module_reg_count,module_wire_count,module_variable_count,module_net_count,"
            "module_signal_count,module_variable_bits,module_net_bits,module_signal_bits,module_internal_signal_count,module_gen_signal_count"
            ") VALUES("
            "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)");

        for (const auto& [definitionKey, representative] : definitionRepresentatives) {
            const auto summaryIt = definitionSignalMap.find(definitionKey);
            if (summaryIt == definitionSignalMap.end()) {
                continue;
            }
            const auto& summary = summaryIt->second;
            definitionStmt.reset();
            bindUInt(definitionStmt.get(), 1, definitionKey);
            bindText(definitionStmt.get(), 2, representative.module);
            bindText(definitionStmt.get(), 3, representative.definitionFilePath);
            bindOptionalInt(definitionStmt.get(), 4, representative.definitionLine);
            bindOptionalInt(definitionStmt.get(), 5, representative.definitionColumn);
            bindOptionalInt(definitionStmt.get(), 6, representative.definitionEndLine);
            bindOptionalInt(definitionStmt.get(), 7, representative.definitionEndColumn);
            bindSize(definitionStmt.get(), 8, representative.definitionShape.portCount);
            bindSize(definitionStmt.get(), 9, representative.definitionShape.logicCount);
            bindSize(definitionStmt.get(), 10, representative.definitionShape.regCount);
            bindSize(definitionStmt.get(), 11, representative.definitionShape.wireCount);
            bindSize(definitionStmt.get(), 12, summary.variableCount);
            bindSize(definitionStmt.get(), 13, summary.netCount);
            bindSize(definitionStmt.get(), 14, summary.signalCount);
            bindUInt(definitionStmt.get(), 15, summary.variableBits);
            bindUInt(definitionStmt.get(), 16, summary.netBits);
            bindUInt(definitionStmt.get(), 17, summary.signalBits);
            bindSize(definitionStmt.get(), 18, summary.internalSignalCount);
            bindSize(definitionStmt.get(), 19, summary.genSignalCount);
            checkSqlite(sqlite3_step(definitionStmt.get()), db,
                        "failed to insert definition row");
        }

        Statement signalStmt(
            db,
            "INSERT INTO definition_signal_stats("
            "definition_key,signal_name,signal_kind,signal_count,total_bits"
            ") VALUES(?1,?2,?3,?4,?5)");

        for (const auto& [definitionKey, summary] : definitionSignalMap) {
            for (const auto& stat : summary.signalStats) {
                signalStmt.reset();
                bindUInt(signalStmt.get(), 1, definitionKey);
                bindText(signalStmt.get(), 2, stat.signalName);
                bindText(signalStmt.get(), 3, stat.signalKind);
                bindSize(signalStmt.get(), 4, stat.signalCount);
                bindUInt(signalStmt.get(), 5, stat.totalBits);
                checkSqlite(sqlite3_step(signalStmt.get()), db,
                            "failed to insert definition signal stat row");
            }
        }

        exec(db, "COMMIT");
    } catch (...) {
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        sqlite3_close(db);
        throw;
    }

    sqlite3_close(db);
}

} // namespace hier
