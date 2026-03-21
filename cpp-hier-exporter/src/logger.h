#pragma once

#include <string_view>

namespace hier {

enum class LogLevel {
    Info,
    Warning,
    Error,
};

void logMessage(LogLevel level, std::string_view component, std::string_view message);

inline void logInfo(std::string_view component, std::string_view message) {
    logMessage(LogLevel::Info, component, message);
}

inline void logWarning(std::string_view component, std::string_view message) {
    logMessage(LogLevel::Warning, component, message);
}

inline void logError(std::string_view component, std::string_view message) {
    logMessage(LogLevel::Error, component, message);
}

} // namespace hier
