#include "logger.h"

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>

#if defined(_WIN32)
#include <io.h>
#define HIER_ISATTY _isatty
#define HIER_FILENO _fileno
#else
#include <unistd.h>
#define HIER_ISATTY isatty
#define HIER_FILENO fileno
#endif

namespace hier {

namespace {

constexpr std::string_view kReset = "\x1b[0m";
constexpr std::string_view kTimestampColor = "\x1b[90m";
constexpr std::string_view kComponentColor = "\x1b[35m";

std::string levelLabel(LogLevel level) {
    switch (level) {
        case LogLevel::Info:
            return "INFO ";
        case LogLevel::Warning:
            return "WARN ";
        case LogLevel::Error:
            return "ERROR";
    }
    return "INFO ";
}

std::string levelColor(LogLevel level) {
    switch (level) {
        case LogLevel::Info:
            return "\x1b[36m";
        case LogLevel::Warning:
            return "\x1b[33m";
        case LogLevel::Error:
            return "\x1b[31m";
    }
    return "\x1b[36m";
}

std::string timestampString() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);

    std::tm localTime {};
#if defined(_WIN32)
    localtime_s(&localTime, &time);
#else
    localtime_r(&time, &localTime);
#endif

    std::ostringstream stream;
    stream << std::put_time(&localTime, "%Y-%m-%d %H:%M:%S");
    return stream.str();
}

bool envEnabled(const char* name) {
    const char* value = std::getenv(name);
    return value && *value && std::string_view(value) != "0";
}

bool envDisabled(const char* name) {
    const char* value = std::getenv(name);
    return value && std::string_view(value) == "0";
}

bool supportsColor() {
    if (const char* mode = std::getenv("HIER_VIEWER_LOG_COLOR")) {
        const std::string_view value(mode);
        if (value == "always" || value == "ALWAYS") {
            return true;
        }
        if (value == "never" || value == "NEVER") {
            return false;
        }
    }

    if (std::getenv("NO_COLOR")) {
        return false;
    }
    if (envEnabled("CLICOLOR_FORCE") || envEnabled("FORCE_COLOR")) {
        return true;
    }
    if (envDisabled("CLICOLOR")) {
        return false;
    }
    if (const char* term = std::getenv("TERM")) {
        if (std::string_view(term) == "dumb") {
            return false;
        }
    }

    return HIER_ISATTY(HIER_FILENO(stderr)) != 0;
}

} // namespace

void logMessage(LogLevel level, std::string_view component, std::string_view message) {
    if (supportsColor()) {
        std::cerr << kTimestampColor << '[' << timestampString() << ']' << kReset << ' '
                  << levelColor(level) << '[' << levelLabel(level) << ']' << kReset << ' '
                  << kComponentColor << '[' << component << ']' << kReset << ' ' << message
                  << '\n';
    } else {
        std::cerr << '[' << timestampString() << "] [" << levelLabel(level) << "] [" << component
                  << "] " << message << '\n';
    }
    std::cerr.flush();
}

} // namespace hier
