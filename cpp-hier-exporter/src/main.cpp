#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "exporter.h"
#include "logger.h"
#include "sqlite_writer.h"
#include "tree.h"

#include "slang/analysis/AnalysisManager.h"
#include "slang/diagnostics/CompilationDiags.h"
#include "slang/diagnostics/DeclarationsDiags.h"
#include "slang/diagnostics/DiagnosticEngine.h"
#include "slang/diagnostics/Diagnostics.h"
#include "slang/driver/Driver.h"
#include "slang/util/VersionInfo.h"

using namespace slang;
using namespace slang::driver;

namespace {

hier::CliOptions parseCliOptions(const std::optional<bool>& treeMode,
                                 const std::optional<bool>& dirMode,
                                 const std::optional<bool>& plainMode,
                                 const std::optional<bool>& csvMode,
                                 const std::optional<bool>& sqliteMode,
                                 const std::optional<bool>& noCompress,
                                 const std::optional<int>& depth,
                                 const std::optional<std::string>& outputPath,
                                 const std::vector<std::string>& excludeWildcards,
                                 const std::vector<std::string>& excludeRegexes) {
    int selectedModeCount = 0;
    selectedModeCount += treeMode == true;
    selectedModeCount += dirMode == true;
    selectedModeCount += plainMode == true;
    selectedModeCount += csvMode == true;
    selectedModeCount += sqliteMode == true;
    if (selectedModeCount > 1) {
        throw std::runtime_error("choose only one output mode: --tree, --dir, --plain, --csv, or --sqlite");
    }

    hier::CliOptions options;
    options.outputPath = outputPath;
    options.viewerConfig.compressPrefix = noCompress != true;
    if (depth) {
        if (*depth <= 0) {
            throw std::runtime_error("--depth requires a positive integer");
        }
        options.viewerConfig.maxDepth = static_cast<size_t>(*depth);
    }
    options.viewerConfig.excludeWildcards = excludeWildcards;
    options.viewerConfig.excludeRegexes = excludeRegexes;

    if (treeMode == true) {
        options.mode = hier::OutputMode::Tree;
    } else if (dirMode == true) {
        options.mode = hier::OutputMode::Dir;
    } else if (plainMode == true) {
        options.mode = hier::OutputMode::Plain;
    } else if (sqliteMode == true) {
        options.mode = hier::OutputMode::Sqlite;
    } else {
        options.mode = hier::OutputMode::Csv;
    }

    if (options.mode == hier::OutputMode::Dir && !options.outputPath) {
        throw std::runtime_error("--dir mode requires -o <path>");
    }
    if (options.mode == hier::OutputMode::Sqlite && !options.outputPath) {
        throw std::runtime_error("--sqlite mode requires -o <file>");
    }

    return options;
}

bool hasSynthesisDefine(const std::vector<std::string>& defines) {
    for (const auto& define : defines) {
        if (define == "SYNTHESIS" || define.rfind("SYNTHESIS=", 0) == 0) {
            return true;
        }
    }
    return false;
}

void printHelp(Driver& driver) {
    std::cout << driver.cmdLine.getHelpText("slang hierarchy exporter") << "\n";
    std::cout << "Examples:\n";
    std::cout << "  slang-hier-exporter rtl.sv\n";
    std::cout << "  slang-hier-exporter --sqlite -o hier.db rtl.sv\n";
    std::cout << "  slang-hier-exporter --plain rtl.sv\n";
    std::cout << "  slang-hier-exporter --tree --depth 2 rtl.sv\n";
    std::cout << "  slang-hier-exporter --exclude-wildcard 'clk_*' rtl.sv\n";
    std::cout << "  slang-hier-exporter -- --top Top +incdir+rtl/include\n";
    std::cout << "\n+define+SYNTHESIS is added automatically unless already specified.\n";
}

} // namespace

int main(int argc, char** argv) {
    try {
        Driver driver;
        driver.addStandardArgs();

        std::optional<bool> showHelp;
        std::optional<bool> showVersion;
        std::optional<bool> treeMode;
        std::optional<bool> dirMode;
        std::optional<bool> plainMode;
        std::optional<bool> csvMode;
        std::optional<bool> sqliteMode;
        std::optional<bool> noCompress;
        std::optional<int> depth;
        std::optional<std::string> outputPath;
        std::vector<std::string> excludeWildcards;
        std::vector<std::string> excludeRegexes;

        driver.cmdLine.add("-h,--help", showHelp, "Display available options");
        driver.cmdLine.add("--version", showVersion, "Display version information and exit");
        driver.cmdLine.add("-t,--tree", treeMode, "Generate ASCII tree output");
        driver.cmdLine.add("-d,--dir", dirMode, "Generate directory hierarchy output");
        driver.cmdLine.add("-p,--plain", plainMode,
                           "Generate plain hierarchy lines: <hierpath> <module>");
        driver.cmdLine.add("-c,--csv", csvMode, "Generate CSV hierarchy output");
        driver.cmdLine.add("-s,--sqlite", sqliteMode,
                           "Generate sqlite hierarchy database with signal details");
        driver.cmdLine.add("-o", outputPath, "Output file/path", "<file>");
        driver.cmdLine.add("--no-compress-prefix", noCompress,
                           "Disable prefix compression in tree mode");
        driver.cmdLine.add("--depth", depth, "Maximum hierarchy depth to keep/output", "<depth>");
        driver.cmdLine.add("--exclude-wildcard", excludeWildcards,
                           "Exclude modules matching a wildcard pattern", "<pattern>");
        driver.cmdLine.add("--exclude-regex", excludeRegexes,
                           "Exclude modules matching a regex pattern", "<pattern>");

        if (!driver.parseCommandLine(argc, argv)) {
            return 1;
        }
        if (showHelp == true) {
            printHelp(driver);
            return 0;
        }
        if (showVersion == true) {
            std::cout << "slang-hier-exporter using slang " << VersionInfo::getMajor() << "."
                      << VersionInfo::getMinor() << "." << VersionInfo::getPatch() << "+"
                      << VersionInfo::getHash() << "\n";
            return 0;
        }

        const auto cliOptions = parseCliOptions(treeMode, dirMode, plainMode, csvMode, sqliteMode,
                                                noCompress, depth, outputPath, excludeWildcards,
                                                excludeRegexes);
        hier::logInfo("slang-hier-exporter", "Starting hierarchy export");

        driver.diagEngine.setSeverity(diag::MissingTimeScale, DiagnosticSeverity::Ignored);
        driver.diagEngine.setSeverity(diag::MismatchedTimeScales, DiagnosticSeverity::Ignored);
        if (!hasSynthesisDefine(driver.options.defines)) {
            driver.options.defines.push_back("SYNTHESIS");
        }

        if (!driver.processOptions()) {
            hier::logError("slang-hier-exporter", "Failed while processing slang options");
            return 2;
        }
        hier::logInfo("slang-hier-exporter", "Processed slang options");
        if (!driver.parseAllSources()) {
            hier::logError("slang-hier-exporter", "Failed while parsing source files");
            return 3;
        }
        hier::logInfo("slang-hier-exporter", "Parsed source files");

        auto compilation = driver.createCompilation();
        driver.reportCompilation(*compilation, true);
        driver.runAnalysis(*compilation);
        const bool compileOk = driver.reportDiagnostics(true);
        if (!compileOk) {
            hier::logWarning("slang-hier-exporter",
                             "Compilation reported errors above; analysis will continue with partial results");
        }
        hier::logInfo("slang-hier-exporter", "Compilation and analysis finished");

        hier::logInfo("slang-hier-exporter", "Collecting hierarchy and signal statistics");
        const auto collected =
            hier::collectHierarchy(*compilation, *compilation->getSourceManager());
        hier::logInfo("slang-hier-exporter", "Collected hierarchy and signal statistics");

        switch (cliOptions.mode) {
            case hier::OutputMode::Dir:
                hier::logInfo("slang-hier-exporter", "Writing directory hierarchy output");
                hier::generateHierarchyDirectory(collected.hierarchyData, *cliOptions.outputPath,
                                                 cliOptions.viewerConfig);
                hier::logInfo("slang-hier-exporter",
                              std::string("Hierarchy directory structure generated at: ") +
                                  *cliOptions.outputPath);
                break;
            case hier::OutputMode::Tree:
                if (cliOptions.outputPath) {
                    hier::logInfo("slang-hier-exporter", "Writing ASCII tree output");
                    std::ofstream output(*cliOptions.outputPath);
                    hier::generateAsciiTree(collected.hierarchyData, output,
                                            cliOptions.viewerConfig);
                    hier::logInfo("slang-hier-exporter",
                                  std::string("ASCII tree written to: ") + *cliOptions.outputPath);
                } else {
                    hier::generateAsciiTree(collected.hierarchyData, std::cout,
                                            cliOptions.viewerConfig);
                }
                break;
            case hier::OutputMode::Plain:
                if (cliOptions.outputPath) {
                    hier::logInfo("slang-hier-exporter", "Writing plain hierarchy output");
                    std::ofstream output(*cliOptions.outputPath);
                    hier::generatePlainHierarchy(collected.hierarchyData, output,
                                                 cliOptions.viewerConfig);
                    hier::logInfo("slang-hier-exporter",
                                  std::string("Plain hierarchy written to: ") + *cliOptions.outputPath);
                } else {
                    hier::generatePlainHierarchy(collected.hierarchyData, std::cout,
                                                 cliOptions.viewerConfig);
                }
                break;
            case hier::OutputMode::Csv:
                if (cliOptions.outputPath) {
                    hier::logInfo("slang-hier-exporter", "Writing CSV hierarchy output");
                    std::ofstream output(*cliOptions.outputPath);
                    hier::generateCsvHierarchy(collected.hierarchyEntries, output,
                                               cliOptions.viewerConfig);
                    hier::logInfo("slang-hier-exporter",
                                  std::string("CSV hierarchy written to: ") + *cliOptions.outputPath);
                } else {
                    hier::generateCsvHierarchy(collected.hierarchyEntries, std::cout,
                                               cliOptions.viewerConfig);
                }
                break;
            case hier::OutputMode::Sqlite:
                hier::logInfo("slang-hier-exporter", "Writing SQLite hierarchy output");
                hier::generateSqliteHierarchy(collected.hierarchyEntries, collected.instanceMetadata,
                                              collected.definitionSignalSummaries,
                                              *cliOptions.outputPath, cliOptions.viewerConfig);
                hier::logInfo("slang-hier-exporter",
                              std::string("SQLite hierarchy written to: ") + *cliOptions.outputPath);
                break;
        }

        return 0;
    } catch (const std::exception& err) {
        hier::logError("slang-hier-exporter", err.what());
        return 1;
    }
}
