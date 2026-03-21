#include "tree.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <regex>
#include <stdexcept>
#include <unordered_map>

#include "filters.h"

namespace fs = std::filesystem;

namespace hier {

HierarchyNode* buildHierarchyTree(const std::vector<std::pair<std::string, std::string>>& instances,
                                  HierarchyNode& storage) {
    if (instances.empty()) {
        return nullptr;
    }

    std::vector<std::pair<std::string, std::string>> sorted = instances;
    std::sort(sorted.begin(), sorted.end());

    std::unordered_map<std::string, HierarchyNode*> pathToNode;
    HierarchyNode* root = nullptr;

    for (const auto& [hierPath, moduleName] : sorted) {
        HierarchyNode node;
        auto split = hierPath.find_last_of('.');
        node.name = split == std::string::npos ? hierPath : hierPath.substr(split + 1);
        node.module = moduleName;

        const std::string parentPath =
            split == std::string::npos ? std::string() : hierPath.substr(0, split);

        if (!parentPath.empty()) {
            auto it = pathToNode.find(parentPath);
            if (it != pathToNode.end()) {
                it->second->children.push_back(std::move(node));
                pathToNode[hierPath] = &it->second->children.back();
                continue;
            }
        }

        storage = std::move(node);
        root = &storage;
        pathToNode[hierPath] = root;
    }

    return root;
}

static std::pair<std::string, std::optional<int>> extractPrefixAndNumber(
    const std::string& name) {
    static const std::regex pattern(R"(^(.+?)(\d+)$)");
    std::smatch match;
    if (std::regex_match(name, match, pattern)) {
        return {match[1].str(), std::stoi(match[2].str())};
    }
    return {name, std::nullopt};
}

static std::string createCompressedName(const std::string& prefix,
                                        const std::vector<int>& numbers) {
    if (numbers.empty()) {
        return prefix;
    }
    if (numbers.size() == 1) {
        return prefix + std::to_string(numbers.front());
    }

    std::vector<std::string> ranges;
    int start = numbers.front();
    int prev = numbers.front();
    for (size_t i = 1; i < numbers.size(); ++i) {
        const int value = numbers[i];
        if (value == prev + 1) {
            prev = value;
            continue;
        }
        ranges.push_back(start == prev ? std::to_string(start)
                                       : std::to_string(start) + "-" + std::to_string(prev));
        start = prev = value;
    }
    ranges.push_back(start == prev ? std::to_string(start)
                                   : std::to_string(start) + "-" + std::to_string(prev));

    std::string body;
    for (size_t i = 0; i < ranges.size(); ++i) {
        if (i) {
            body += ",";
        }
        body += ranges[i];
    }
    return prefix + "<" + body + ">";
}

static std::vector<HierarchyNode> mergeChildren(
    const std::vector<std::vector<HierarchyNode>>& childrenLists) {
    if (childrenLists.empty()) {
        return {};
    }
    if (childrenLists.size() == 1) {
        return childrenLists.front();
    }

    std::map<std::pair<std::string, std::string>, std::vector<HierarchyNode>> groups;
    for (const auto& children : childrenLists) {
        for (const auto& child : children) {
            groups[{child.name, child.module}].push_back(child);
        }
    }

    std::vector<HierarchyNode> result;
    for (auto& [key, nodes] : groups) {
        HierarchyNode merged;
        merged.name = key.first;
        merged.module = key.second;

        std::vector<std::vector<HierarchyNode>> grandChildren;
        for (const auto& node : nodes) {
            grandChildren.push_back(node.children);
        }
        merged.children = mergeChildren(grandChildren);
        result.push_back(std::move(merged));
    }
    return result;
}

HierarchyNode compressTree(const HierarchyNode& node) {
    if (node.children.empty()) {
        return node;
    }

    std::vector<HierarchyNode> compressedChildren;
    compressedChildren.reserve(node.children.size());
    for (const auto& child : node.children) {
        compressedChildren.push_back(compressTree(child));
    }

    std::map<std::pair<std::string, std::string>,
             std::vector<std::pair<std::optional<int>, HierarchyNode>>>
        groups;
    for (const auto& child : compressedChildren) {
        auto [prefix, number] = extractPrefixAndNumber(child.name);
        const auto key = number ? std::make_pair(child.module, prefix)
                                : std::make_pair(child.module, child.name);
        groups[key].push_back({number, child});
    }

    HierarchyNode result;
    result.name = node.name;
    result.module = node.module;

    for (auto& [key, items] : groups) {
        if (items.size() == 1) {
            result.children.push_back(items.front().second);
            continue;
        }

        std::vector<int> numbers;
        bool allNumbered = true;
        for (const auto& [number, _] : items) {
            if (!number) {
                allNumbered = false;
                break;
            }
            numbers.push_back(*number);
        }

        if (!allNumbered) {
            for (const auto& [_, child] : items) {
                result.children.push_back(child);
            }
            continue;
        }

        std::sort(numbers.begin(), numbers.end());
        HierarchyNode compressed;
        compressed.name = createCompressedName(key.second, numbers);
        compressed.module = key.first;

        std::vector<std::vector<HierarchyNode>> childrenLists;
        for (const auto& [_, child] : items) {
            childrenLists.push_back(child.children);
        }
        compressed.children = mergeChildren(childrenLists);
        result.children.push_back(std::move(compressed));
    }

    return result;
}

static void treeToAscii(const HierarchyNode& node,
                        std::ostream& output,
                        size_t depth,
                        const std::optional<size_t>& maxDepth,
                        const std::string& prefix,
                        bool isLast) {
    constexpr std::string_view branch = "├── ";
    constexpr std::string_view lastBranch = "└── ";
    constexpr std::string_view vertical = "│   ";
    constexpr std::string_view space = "    ";

    if (depth == 0) {
        output << node.name << " (" << node.module << ")\n";
    } else {
        output << prefix << (isLast ? lastBranch : branch) << node.name << " (" << node.module
               << ")\n";
    }

    if (maxDepth && depth >= *maxDepth - 1 && !node.children.empty()) {
        const std::string nextPrefix =
            depth > 0 ? prefix + std::string(isLast ? space : vertical) : std::string();
        output << nextPrefix << lastBranch << "... (depth limited: " << *maxDepth << ")\n";
        return;
    }

    const std::string childPrefix =
        depth == 0 ? std::string() : prefix + std::string(isLast ? space : vertical);
    for (size_t i = 0; i < node.children.size(); ++i) {
        treeToAscii(node.children[i], output, depth + 1, maxDepth, childPrefix,
                    i + 1 == node.children.size());
    }
}

void generateAsciiTree(const std::vector<std::pair<std::string, std::string>>& hierarchyData,
                       std::ostream& output,
                       const ViewerConfig& config) {
    const auto compiled = compileViewerConfig(config);
    std::vector<std::pair<std::string, std::string>> filtered;
    for (const auto& item : hierarchyData) {
        if (!shouldExcludeModuleFast(item.second, compiled)) {
            filtered.push_back(item);
        }
    }
    if (filtered.empty()) {
        output << "(empty hierarchy)\n";
        return;
    }

    HierarchyNode storage;
    HierarchyNode* tree = buildHierarchyTree(filtered, storage);
    if (!tree) {
        output << "(empty hierarchy)\n";
        return;
    }

    HierarchyNode finalTree = config.compressPrefix ? compressTree(*tree) : *tree;
    treeToAscii(finalTree, output, 0, config.maxDepth, "", true);
}

void generatePlainHierarchy(const std::vector<std::pair<std::string, std::string>>& hierarchyData,
                            std::ostream& output,
                            const ViewerConfig& config) {
    const auto compiled = compileViewerConfig(config);
    std::vector<std::pair<std::string, std::string>> filtered;
    for (const auto& item : hierarchyData) {
        if (shouldExcludeModuleFast(item.second, compiled)) {
            continue;
        }
        if (compiled.maxDepth && hierarchyDepth(item.first) >= *compiled.maxDepth) {
            continue;
        }
        filtered.push_back(item);
    }

    if (filtered.empty()) {
        output << "(empty hierarchy)\n";
        return;
    }

    std::sort(filtered.begin(), filtered.end());
    for (const auto& [path, module] : filtered) {
        output << path << " <" << module << ">\n";
    }
}

static void generateDirRecursive(const HierarchyNode& node,
                                 const fs::path& currentPath,
                                 const std::string& fullHierPath) {
    const fs::path nodePath = currentPath / node.name;
    if (!node.children.empty()) {
        fs::create_directories(nodePath);
        std::ofstream moduleFile(nodePath / ".moduleName");
        moduleFile << node.module << "\n";
        for (const auto& child : node.children) {
            generateDirRecursive(child, nodePath, fullHierPath + "." + child.name);
        }
        return;
    }

    std::ofstream leaf(nodePath);
    leaf << "hierarchicalPath: " << fullHierPath << "\n";
    leaf << "moduleName: " << node.module << "\n";
}

void generateHierarchyDirectory(
    const std::vector<std::pair<std::string, std::string>>& hierarchyData,
    const std::string& outputDir,
    const ViewerConfig& config) {
    const auto compiled = compileViewerConfig(config);
    std::vector<std::pair<std::string, std::string>> filtered;
    for (const auto& item : hierarchyData) {
        if (shouldExcludeModuleFast(item.second, compiled)) {
            continue;
        }
        if (compiled.maxDepth && hierarchyDepth(item.first) >= *compiled.maxDepth) {
            continue;
        }
        filtered.push_back(item);
    }

    if (filtered.empty()) {
        return;
    }

    HierarchyNode storage;
    HierarchyNode* tree = buildHierarchyTree(filtered, storage);
    if (!tree) {
        return;
    }

    fs::remove_all(outputDir);
    fs::create_directories(outputDir);
    generateDirRecursive(*tree, fs::path(outputDir), tree->name);
}

} // namespace hier
