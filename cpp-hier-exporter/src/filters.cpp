#include "filters.h"

#include <algorithm>
#include <stdexcept>

namespace hier {

static std::regex wildcardToRegex(const std::string& pattern) {
    std::string regex = "^";
    regex.reserve(pattern.size() * 2 + 2);
    for (char ch : pattern) {
        switch (ch) {
            case '*':
                regex += ".*";
                break;
            case '?':
                regex += '.';
                break;
            case '.':
            case '+':
            case '^':
            case '$':
            case '(':
            case ')':
            case '[':
            case ']':
            case '{':
            case '}':
            case '|':
            case '\\':
                regex += '\\';
                regex += ch;
                break;
            default:
                regex += ch;
                break;
        }
    }
    regex += '$';
    return std::regex(regex, std::regex::ECMAScript);
}

CompiledViewerConfig compileViewerConfig(const ViewerConfig& config) {
    CompiledViewerConfig compiled;
    compiled.compressPrefix = config.compressPrefix;
    compiled.maxDepth = config.maxDepth;
    compiled.excludeWildcards = config.excludeWildcards;
    for (const auto& pattern : config.excludeRegexes) {
        try {
            compiled.excludeRegexes.emplace_back(pattern, std::regex::ECMAScript);
        } catch (const std::regex_error&) {
            throw std::runtime_error("invalid regex pattern: " + pattern);
        }
    }
    return compiled;
}

bool shouldExcludeModuleFast(const std::string& moduleName,
                             const CompiledViewerConfig& config) {
    for (const auto& pattern : config.excludeWildcards) {
        if (std::regex_match(moduleName, wildcardToRegex(pattern))) {
            return true;
        }
    }
    for (const auto& regex : config.excludeRegexes) {
        if (std::regex_search(moduleName, regex)) {
            return true;
        }
    }
    return false;
}

size_t hierarchyDepth(const std::string& path) {
    return static_cast<size_t>(std::count(path.begin(), path.end(), '.'));
}

} // namespace hier
