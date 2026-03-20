#!/usr/bin/env python3
"""
Dependency Installation:
    pip install pyslang
    python3 -m pip install pyslang

To use PyPI mirror (temporary):
    pip install pyslang -i https://pypi.tuna.tsinghua.edu.cn/simple
    python3 -m pip install pyslang -i https://pypi.tuna.tsinghua.edu.cn/simple

Usage:
    python3 main.py [OPTIONS] <files>
    python3 main.py -o output.md Top.v          # Output to file
    python3 main.py Top.v                        # Output to stdout
    python3 main.py --depth 2 Top.v              # Limit depth to 2
    python3 main.py -ncp Top.v                   # Disable prefix compression
    python3 main.py -p -o hier.txt Top.v         # Output plain hierarchy paths
    python3 main.py --exclude-wildcard "clk*" Top.v  # Exclude modules matching wildcard
"""

import sys
import re
import fnmatch
import csv
import os
import hashlib
import sqlite3
import pyslang
from typing import Dict, List, Optional, TextIO, Tuple, Iterable
from collections import defaultdict
from dataclasses import dataclass, field

# ANSI color codes
class Colors:
    RED = '\033[91m'
    YELLOW = '\033[93m'
    GREEN = '\033[92m'
    CYAN = '\033[96m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    RESET = '\033[0m'

def color_text(text, color):
    return f"{color}{text}{Colors.RESET}"

def print_help():
    """Print help information"""
    import os
    script_name = os.path.basename(sys.argv[0])

    print(f"\n{Colors.BOLD}Verilog/SystemVerilog Hierarchy Viewer{Colors.RESET}")
    print("-" * 80)
    print()
    print(f"{Colors.BOLD}Usage:{Colors.RESET}")
    print(f"  python {script_name} [MODE] [OPTIONS] [COMPILER_ARGS] <files>")
    print()
    print(f"{Colors.BOLD}Output Modes (mutually exclusive, pick ONE):{Colors.RESET}")
    print("  -t, --tree             Generate ASCII tree view (like 'tree' command)")
    print("  -d, --dir              Generate directory structure representing hierarchy")
    print("                         Each module becomes a directory with .moduleName file")
    print("                         Leaf modules become files with hieraPath and moduleName")
    print("  -p, --plain            Generate plain hierarchy list: one 'path <ModuleName>' per line")
    print("  -c, --csv              Generate CSV hierarchy with source location metadata")
    print("  -s, --sqlite           Generate sqlite hierarchy database with signal details")
    print()
    print(f"{Colors.BOLD}Options:{Colors.RESET}")
    print("  -o <file/path>         Output file for tree/plain/csv/sqlite, or directory path for --dir")
    print("                         (default: stdout for tree/plain/csv)")
    print("  -f <filelist>          Read source files from a filelist file")
    print("  --top <module>         Specify top-level module name")
    print("  --depth <N>            Limit display depth (default: unlimited)")
    print("                         Truncated nodes shown as '... (depth limited: N)'")
    print("  -ncp, --no-compress-prefix")
    print("                         Disable prefix compression (default: enabled)")
    print("                         e.g., mod_1, mod_2 -> mod_<1-2>")
    print("  --exclude-wildcard <pattern>")
    print("                         Exclude modules matching wildcard pattern")
    print("                         Can be used multiple times")
    print("  --exclude-regex <pattern>")
    print("                         Exclude modules matching regex pattern")
    print("                         Can be used multiple times")
    print("  -h, --help             Show this help message")
    print()
    print(f"{Colors.BOLD}Compiler Arguments:{Colors.RESET}")
    print("  +incdir+<path>           Add include directory for file search")
    print("  +define+<macro>=<value>  Define macro with optional value")
    print("  +define+<macro>          Define macro as boolean flag")
    print()
    print(f"{Colors.BOLD}  Default defines automatically added:{Colors.RESET}")
    print("  +define+SYNTHESIS         Define SYNTHESIS macro (auto-added)")
    print()
    print(f"{Colors.BOLD}Prefix Compression (for tree mode):{Colors.RESET}")
    print("  By default, instances with similar names are compressed:")
    print("    mod_0, mod_1, mod_2  ->  mod_<0-2>")
    print("    sub_a1, sub_a2       ->  sub_a<1-2>")
    print("  Use -ncp to disable this feature.")
    print()
    print(f"{Colors.BOLD}Examples:{Colors.RESET}")
    print(f"  python {script_name} rtl.sv                         # CSV to stdout")
    print(f"  python {script_name} -t rtl.sv                      # Tree to stdout")
    print(f"  python {script_name} -t -o hier.txt rtl.sv          # Tree to file")
    print(f"  python {script_name} -d -o ./hier_dir rtl.sv        # Directory structure")
    print(f"  python {script_name} -p -o hier.txt rtl.sv          # Plain hierarchy list with module names")
    print(f"  python {script_name} -c -o hier.csv rtl.sv          # CSV hierarchy with source locations")
    print(f"  python {script_name} -s -o hier.db rtl.sv           # SQLite hierarchy DB with signals")
    print(f"  python {script_name} --depth 2 rtl.sv               # Limit to depth 2")
    print(f"  python {script_name} -ncp rtl.sv                    # No compression")
    print(f"  python {script_name} --exclude-wildcard 'clk_*' rtl.sv")
    print(f"  python {script_name} --exclude-regex '^RAM_.*' rtl.sv")
    print()

@dataclass
class ViewerConfig:
    """Configuration for hierarchy export and filtering."""
    compress_prefix: bool = True      # Enable prefix compression
    max_depth: Optional[int] = None   # Maximum depth to display (None = unlimited)
    exclude_wildcards: List[str] = field(default_factory=list)  # Wildcard patterns to exclude
    exclude_regexes: List[str] = field(default_factory=list)    # Regex patterns to exclude


@dataclass(frozen=True)
class CompiledViewerConfig:
    """Runtime-friendly version of ViewerConfig with precompiled matchers."""
    compress_prefix: bool = True
    max_depth: Optional[int] = None
    exclude_wildcards: Tuple[str, ...] = ()
    exclude_regexes: Tuple[re.Pattern[str], ...] = ()


@dataclass
class HierarchyEntry:
    path: str
    module: str
    file_path: str = ""
    line: Optional[int] = None
    column: Optional[int] = None
    end_line: Optional[int] = None
    end_column: Optional[int] = None
    definition_file_path: str = ""
    definition_line: Optional[int] = None
    definition_column: Optional[int] = None
    definition_end_line: Optional[int] = None
    definition_end_column: Optional[int] = None
    module_port_count: int = 0
    module_logic_count: int = 0
    module_reg_count: int = 0
    module_wire_count: int = 0
    module_variable_count: int = 0
    module_net_count: int = 0
    module_signal_count: int = 0
    module_variable_bits: int = 0
    module_net_bits: int = 0
    module_signal_bits: int = 0
    module_internal_signal_count: int = 0
    module_gen_signal_count: int = 0


@dataclass(frozen=True)
class ModuleMetrics:
    port_count: int = 0
    logic_count: int = 0
    reg_count: int = 0
    wire_count: int = 0
    variable_count: int = 0
    net_count: int = 0
    signal_count: int = 0
    variable_bits: int = 0
    net_bits: int = 0
    signal_bits: int = 0


@dataclass(frozen=True)
class InstanceMetadata:
    path: str
    module: str
    definition_key: Optional[int] = None
    file_path: str = ""
    line: Optional[int] = None
    column: Optional[int] = None
    end_line: Optional[int] = None
    end_column: Optional[int] = None
    definition_file_path: str = ""
    definition_line: Optional[int] = None
    definition_column: Optional[int] = None
    definition_end_line: Optional[int] = None
    definition_end_column: Optional[int] = None
    definition_shape: ModuleMetrics = field(default_factory=ModuleMetrics)


@dataclass(frozen=True)
class DefinitionSignalStatSummary:
    signal_name: str = ""
    signal_kind: str = ""
    signal_count: int = 0
    total_bits: int = 0


@dataclass(frozen=True)
class DefinitionSignalSummary:
    variable_count: int = 0
    net_count: int = 0
    signal_count: int = 0
    variable_bits: int = 0
    net_bits: int = 0
    signal_bits: int = 0
    internal_signal_count: int = 0
    gen_signal_count: int = 0
    signal_stats: Tuple[DefinitionSignalStatSummary, ...] = ()


def should_exclude_module(module_name: str, config: ViewerConfig) -> bool:
    """
    Check if a module should be excluded based on wildcard or regex patterns.

    Args:
        module_name: The module name to check
        config: ViewerConfig with exclude patterns

    Returns:
        True if module should be excluded, False otherwise
    """
    # Check wildcard patterns
    for pattern in config.exclude_wildcards:
        if fnmatch.fnmatch(module_name, pattern):
            return True

    # Check regex patterns
    for pattern in config.exclude_regexes:
        try:
            if re.search(pattern, module_name):
                return True
        except re.error:
            print(f"Warning: Invalid regex pattern: {pattern}", file=sys.stderr)

    return False


def compile_viewer_config(config: ViewerConfig) -> CompiledViewerConfig:
    compiled_regexes: List[re.Pattern[str]] = []
    for pattern in config.exclude_regexes:
        try:
            compiled_regexes.append(re.compile(pattern))
        except re.error:
            print(f"Warning: Invalid regex pattern: {pattern}", file=sys.stderr)

    return CompiledViewerConfig(
        compress_prefix=config.compress_prefix,
        max_depth=config.max_depth,
        exclude_wildcards=tuple(config.exclude_wildcards),
        exclude_regexes=tuple(compiled_regexes),
    )


def should_exclude_module_fast(module_name: str, config: CompiledViewerConfig) -> bool:
    for pattern in config.exclude_wildcards:
        if fnmatch.fnmatch(module_name, pattern):
            return True

    for regex in config.exclude_regexes:
        if regex.search(module_name):
            return True

    return False


# ============================================================================
# HIERARCHY TREE AND COMPRESSION
# ============================================================================

class HierarchyNode:
    """
    Tree node for hierarchy representation.

    Tree Structure:
    ===============
        HierarchyNode(name="Top", module="Top", children=[
            HierarchyNode(name="mod_0", module="SubMod", children=[
                HierarchyNode(name="cpu", module="CPU", children=[])
            ]),
            HierarchyNode(name="mod_1", module="SubMod", children=[...])
        ])

    After compression:
        HierarchyNode(name="mod_<0-1>", module="SubMod", children=[
            HierarchyNode(name="cpu", module="CPU", children=[])  # deduplicated
        ])
    """
    def __init__(self, name: str, module: str):
        self.name = name      # Instance name (e.g., "mod_0" or "mod_<0-1>")
        self.module = module  # Module type name (e.g., "SubMod")
        self.children: List["HierarchyNode"] = []

    def __repr__(self) -> str:
        return f"HierarchyNode({self.name}: {self.module}, {len(self.children)} children)"


def build_hierarchy_tree(instances: List[Tuple[str, str]]) -> Optional[HierarchyNode]:
    """
    Build a tree structure from flat (path, module) list.

    Algorithm:
    ==========
        1. Sort instances by path
        2. Create root node from first entry (depth 0)
        3. For each instance, find its parent in the tree
        4. Add as child of parent

    Example:
    ========
        Input:
            [("Top", "TopMod"), ("Top.u_sub", "SubMod"), ("Top.u_sub.u_leaf", "Leaf")]

        Output:
            Top (TopMod)
             └─ u_sub (SubMod)
                 └─ u_leaf (Leaf)

    Args:
        instances: List of (hierarchicalPath, moduleName) tuples

    Returns:
        Root HierarchyNode or None if empty
    """
    if not instances:
        return None

    # Sort by path to ensure parents come before children
    sorted_instances = sorted(instances, key=lambda x: x[0])

    # Create path -> node mapping for tree building
    path_to_node: Dict[str, HierarchyNode] = {}
    root: Optional[HierarchyNode] = None

    for hier_path, module_name in sorted_instances:
        instance_name = hier_path.split('.')[-1]
        node = HierarchyNode(instance_name, module_name)
        path_to_node[hier_path] = node

        # Find parent path
        parent_path = '.'.join(hier_path.split('.')[:-1])

        if not parent_path:
            # This is root
            root = node
        elif parent_path in path_to_node:
            path_to_node[parent_path].children.append(node)
        else:
            # Parent not found - this might be root with no explicit parent
            if root is None:
                root = node

    return root


def _extract_prefix_and_number(name: str) -> Tuple[str, Optional[int]]:
    """
    Extract prefix and trailing number from instance name.

    Examples:
    =========
        "mod_0"    -> ("mod_", 0)
        "sub1"     -> ("sub", 1)
        "u_ram_12" -> ("u_ram_", 12)
        "cpu"      -> ("cpu", None)
    """
    match = re.search(r'^(.+?)(\d+)$', name)
    if match:
        return match.group(1), int(match.group(2))
    return name, None


def _create_compressed_name(prefix: str, numbers: List[int]) -> str:
    """
    Create compressed name from prefix and sorted number list.

    Examples:
    =========
        prefix="mod_", numbers=[0,1,2]     -> "mod_<0-2>"
        prefix="u_",   numbers=[1,3,5,7]   -> "u_<1,3,5,7>"
        prefix="ram_", numbers=[0,1,2,5]   -> "ram_<0-2,5>"

    Algorithm:
    ==========
        1. Find consecutive ranges: [0,1,2,5] -> [(0,2), (5,5)]
        2. Format ranges: "0-2", "5"
        3. Join with comma: "0-2,5"
    """
    if not numbers:
        return prefix.rstrip('_')

    if len(numbers) == 1:
        return f"{prefix}{numbers[0]}"

    # Find consecutive ranges
    ranges: List[str] = []
    start = numbers[0]
    prev = numbers[0]

    for num in numbers[1:]:
        if num == prev + 1:
            prev = num
        else:
            # End current range
            if start == prev:
                ranges.append(str(start))
            else:
                ranges.append(f"{start}-{prev}")
            start = num
            prev = num

    # Close last range
    if start == prev:
        ranges.append(str(start))
    else:
        ranges.append(f"{start}-{prev}")

    return f"{prefix}<{','.join(ranges)}>"


def _merge_children(children_lists: List[List[HierarchyNode]]) -> List[HierarchyNode]:
    """
    Merge multiple children lists into one, deduplicating equivalent subtrees.

    Algorithm:
    ==========
        1. For each unique (name, module) combination, collect all child nodes
        2. Recursively merge their children
        3. Return deduplicated list

    Example:
    ========
        Input: [
            [Node("cpu", "CPU", [leaf1]), Node("ram_0", "RAM", [])],
            [Node("cpu", "CPU", [leaf1]), Node("ram_1", "RAM", [])]
        ]
        Output: [
            Node("cpu", "CPU", [leaf1]),   # deduplicated
            Node("ram_0", "RAM", []),
            Node("ram_1", "RAM", [])       # different name, not merged
        ]
    """
    if not children_lists:
        return []

    if len(children_lists) == 1:
        return children_lists[0]

    # Group by (name, module)
    groups: Dict[Tuple[str, str], List[HierarchyNode]] = defaultdict(list)

    for children in children_lists:
        for child in children:
            groups[(child.name, child.module)].append(child)

    result = []
    for (name, module), nodes in groups.items():
        # Create merged node
        merged = HierarchyNode(name, module)

        # Recursively merge children of all nodes in this group
        all_grandchildren = [n.children for n in nodes]
        merged.children = _merge_children(all_grandchildren)

        result.append(merged)

    return result


def compress_tree(node: HierarchyNode) -> HierarchyNode:
    """
    Compress a hierarchy tree by merging siblings with common prefix.

    Algorithm Flow:
    ===============
        ┌─────────────────────────────────────────────────────────────┐
        │  Input: HierarchyNode with children                         │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  1. Recursively compress all children first                 │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  2. Group children by (module, prefix)                      │
        │     e.g., [mod_0:Sub, mod_1:Sub] -> group by ("Sub","mod_") │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  3. For each group with >1 items:                           │
        │     - Create compressed name: mod_<0-1>                     │
        │     - Merge children of all grouped nodes                   │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  4. Return node with compressed children                    │
        └─────────────────────────────────────────────────────────────┘

    Example:
    ========
        Before:
            Top
            ├─ mod_0: SubMod
            │   └─ cpu: CPU
            ├─ mod_1: SubMod
            │   └─ cpu: CPU
            └─ other: Other

        After:
            Top
            ├─ mod_<0-1>: SubMod
            │   └─ cpu: CPU  (deduplicated)
            └─ other: Other
    """
    if not node.children:
        return node

    # Step 1: Recursively compress all children first
    compressed_children = [compress_tree(child) for child in node.children]

    # Step 2: Group by (module_name, prefix)
    groups: Dict[Tuple[str, str], List[Tuple[Optional[int], HierarchyNode]]] = defaultdict(list)

    for child in compressed_children:
        prefix, number = _extract_prefix_and_number(child.name)
        if number is not None:
            key = (child.module, prefix)
        else:
            # No number suffix - use full name as key to prevent wrong grouping
            key = (child.module, child.name)
        groups[key].append((number, child))

    # Step 3: Create compressed children list
    new_children = []

    for (module_name, prefix_or_name), items in groups.items():
        if len(items) == 1:
            # Single item, no compression needed
            new_children.append(items[0][1])
        else:
            # Check if all items have numbers (can be compressed)
            numbers = [n for n, _ in items if n is not None]

            if len(numbers) == len(items):
                # All have numbers - compress
                numbers_sorted = sorted(numbers)
                compressed_name = _create_compressed_name(prefix_or_name, numbers_sorted)

                # Create compressed node with merged children
                compressed_node = HierarchyNode(compressed_name, module_name)
                children_lists = [c.children for _, c in items]
                compressed_node.children = _merge_children(children_lists)

                new_children.append(compressed_node)
            else:
                # Some don't have numbers - add all individually
                for _, child in items:
                    new_children.append(child)

    # Create result node with compressed children
    result = HierarchyNode(node.name, node.module)
    result.children = new_children

    return result

# ============================================================================
# ASCII TREE VIEW GENERATION
# ============================================================================

def tree_to_ascii(node: HierarchyNode, output: TextIO, depth: int = 0,
                  max_depth: Optional[int] = None, prefix: str = "",
                  is_last: bool = True) -> None:
    """
    Convert hierarchy tree to ASCII tree format (like 'tree' command).

    Output Format:
    ==============
        Top (TopMod)
        ├── mod_0 (SubMod)
        │   └── cpu (CPU)
        └── mod_1 (SubMod)
            └── ... (depth limited: 2)

    Args:
        node: Current node to output
        output: Output file object
        depth: Current depth (0 = root)
        max_depth: Maximum depth to output (None = unlimited)
        prefix: Prefix string for tree lines
        is_last: Whether this is the last child at current level
    """
    # Tree characters
    BRANCH = "├── "
    LAST_BRANCH = "└── "
    VERTICAL = "│   "
    SPACE = "    "

    if depth == 0:
        # Root node
        output.write(f"{node.name} ({node.module})\n")
    else:
        # Child node
        connector = LAST_BRANCH if is_last else BRANCH
        output.write(f"{prefix}{connector}{node.name} ({node.module})\n")

    # Check if we should show truncation indicator
    if max_depth is not None and depth >= max_depth - 1 and node.children:
        # We're at max_depth-1, so children would be at max_depth
        # Show truncation indicator for the children that would be hidden
        new_prefix = prefix + (SPACE if is_last else VERTICAL) if depth > 0 else ""
        output.write(f"{new_prefix}{LAST_BRANCH}... (depth limited: {max_depth})\n")
        return

    # Calculate prefix for children
    if depth == 0:
        child_prefix = ""
    else:
        child_prefix = prefix + (SPACE if is_last else VERTICAL)

    # Recursively output children
    for i, child in enumerate(node.children):
        child_is_last = (i == len(node.children) - 1)
        tree_to_ascii(child, output, depth + 1, max_depth, child_prefix, child_is_last)


def generate_ascii_tree(hierarchy_data: List[Tuple[str, str]], output: TextIO,
                        config: Optional[ViewerConfig] = None) -> None:
    """
    Generate an ASCII tree from hierarchy data.

    Algorithm Flow:
    ===============
        ┌─────────────────────────────────────────────────────────────┐
        │  1. Filter excluded modules (wildcard/regex)                │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  2. Build tree structure from flat path list                │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  3. Apply compression (merge mod_0, mod_1 -> mod_<0-1>)     │
        │     - Recursively compress at each level                    │
        │     - Deduplicate merged children                           │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  4. Output as ASCII tree with depth limit and truncation    │
        └─────────────────────────────────────────────────────────────┘

    Tree Structure:
    ===============
        Top (TopMod)
        ├── mod_<0-3> (SubModule)
        │   └── cpu (CPU)
        └── other (Other)
            └── ... (depth limited: 2)

    Args:
        hierarchy_data: List of (hierarchicalPath, moduleName) tuples
        output: Output file object (can be sys.stdout or a file)
        config: ViewerConfig for generation options
    """
    if config is None:
        config = ViewerConfig()
    compiled_config = compile_viewer_config(config)

    # Step 1: Filter excluded modules
    filtered_data = [
        (path, mod) for path, mod in hierarchy_data
        if not should_exclude_module_fast(mod, compiled_config)
    ]

    if not filtered_data:
        output.write("(empty hierarchy)\n")
        return

    # Step 2: Build tree structure
    tree = build_hierarchy_tree(filtered_data)
    if tree is None:
        output.write("(empty hierarchy)\n")
        return

    # Step 3: Apply compression if enabled
    if config.compress_prefix:
        tree = compress_tree(tree)

    # Step 4: Output as ASCII tree with depth limit
    tree_to_ascii(tree, output, depth=0, max_depth=config.max_depth)

def generate_plain_hierarchy(hierarchy_data: List[Tuple[str, str]], output: TextIO,
                             config: Optional[ViewerConfig] = None) -> None:
    """
    Generate a plain hierarchy list, one 'path <ModuleName>' per line.

    Example:
        Top <top>
        Top.u_sub <mid>
        Top.u_sub.u_leaf <leaf>
        Top.u_other <leaf>
    """
    if config is None:
        config = ViewerConfig()
    compiled_config = compile_viewer_config(config)

    filtered_entries = [
        (path, mod) for path, mod in hierarchy_data
        if not should_exclude_module_fast(mod, compiled_config)
        and (compiled_config.max_depth is None or path.count('.') < compiled_config.max_depth)
    ]

    if not filtered_entries:
        output.write("(empty hierarchy)\n")
        return

    for path, mod in sorted(filtered_entries, key=lambda item: item[0]):
        output.write(f"{path} <{mod}>\n")


def generate_csv_hierarchy(hierarchy_data: List[HierarchyEntry], output: TextIO,
                           config: Optional[ViewerConfig] = None) -> None:
    """
    Generate CSV hierarchy with source location metadata.

    Columns:
        path,module,file_path,line,column,end_line,end_column,
        definition_file_path,definition_line,definition_column,
        definition_end_line,definition_end_column,
        module_port_count,module_logic_count,module_reg_count,
        module_wire_count,module_variable_count,module_net_count,
        module_signal_count,module_variable_bits,module_net_bits,
        module_signal_bits,module_internal_signal_count,module_gen_signal_count
    """
    if config is None:
        config = ViewerConfig()
    compiled_config = compile_viewer_config(config)

    filtered_entries = [
        entry for entry in hierarchy_data
        if not should_exclude_module_fast(entry.module, compiled_config)
        and (compiled_config.max_depth is None or entry.path.count('.') < compiled_config.max_depth)
    ]

    writer = csv.writer(output, lineterminator="\n")
    writer.writerow([
        "path",
        "module",
        "file_path",
        "line",
        "column",
        "end_line",
        "end_column",
        "definition_file_path",
        "definition_line",
        "definition_column",
        "definition_end_line",
        "definition_end_column",
        "module_port_count",
        "module_logic_count",
        "module_reg_count",
        "module_wire_count",
        "module_variable_count",
        "module_net_count",
        "module_signal_count",
        "module_variable_bits",
        "module_net_bits",
        "module_signal_bits",
        "module_internal_signal_count",
        "module_gen_signal_count",
    ])

    for entry in sorted(filtered_entries, key=lambda item: item.path):
        writer.writerow([
            entry.path,
            entry.module,
            entry.file_path,
            "" if entry.line is None else entry.line,
            "" if entry.column is None else entry.column,
            "" if entry.end_line is None else entry.end_line,
            "" if entry.end_column is None else entry.end_column,
            entry.definition_file_path,
            "" if entry.definition_line is None else entry.definition_line,
            "" if entry.definition_column is None else entry.definition_column,
            "" if entry.definition_end_line is None else entry.definition_end_line,
            "" if entry.definition_end_column is None else entry.definition_end_column,
            entry.module_port_count,
            entry.module_logic_count,
            entry.module_reg_count,
            entry.module_wire_count,
            entry.module_variable_count,
            entry.module_net_count,
            entry.module_signal_count,
            entry.module_variable_bits,
            entry.module_net_bits,
            entry.module_signal_bits,
            entry.module_internal_signal_count,
            entry.module_gen_signal_count,
        ])


def generate_sqlite_hierarchy(hierarchy_data: List[HierarchyEntry],
                              instance_metadata: List[InstanceMetadata],
                              definition_signal_cache: Dict[int, DefinitionSignalSummary],
                              output_path: str,
                              config: Optional[ViewerConfig] = None) -> None:
    if config is None:
        config = ViewerConfig()
    compiled_config = compile_viewer_config(config)

    filtered_entries = [
        entry for entry in hierarchy_data
        if not should_exclude_module_fast(entry.module, compiled_config)
        and (compiled_config.max_depth is None or entry.path.count('.') < compiled_config.max_depth)
    ]
    allowed_paths = {entry.path for entry in filtered_entries}
    filtered_instances = [
        metadata for metadata in instance_metadata
        if metadata.path in allowed_paths
    ]
    definition_representatives: Dict[int, InstanceMetadata] = {}
    instance_definition_keys = {
        metadata.path: metadata.definition_key for metadata in filtered_instances
    }
    for metadata in filtered_instances:
        if metadata.definition_key is not None and metadata.definition_key not in definition_representatives:
            definition_representatives[metadata.definition_key] = metadata

    if os.path.exists(output_path):
        os.remove(output_path)

    connection = sqlite3.connect(output_path)
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("PRAGMA cache_size=-200000")

        connection.executescript("""
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE instances (
                path TEXT PRIMARY KEY,
                parent_path TEXT,
                instance_name TEXT NOT NULL,
                module TEXT NOT NULL,
                definition_key INTEGER,
                file_path TEXT NOT NULL,
                line INTEGER,
                column INTEGER,
                end_line INTEGER,
                end_column INTEGER,
                definition_file_path TEXT NOT NULL,
                definition_line INTEGER,
                definition_column INTEGER,
                definition_end_line INTEGER,
                definition_end_column INTEGER,
                module_port_count INTEGER NOT NULL,
                module_logic_count INTEGER NOT NULL,
                module_reg_count INTEGER NOT NULL,
                module_wire_count INTEGER NOT NULL,
                module_variable_count INTEGER NOT NULL,
                module_net_count INTEGER NOT NULL,
                module_signal_count INTEGER NOT NULL,
                module_variable_bits INTEGER NOT NULL,
                module_net_bits INTEGER NOT NULL,
                module_signal_bits INTEGER NOT NULL,
                module_internal_signal_count INTEGER NOT NULL,
                module_gen_signal_count INTEGER NOT NULL
            );

            CREATE TABLE definitions (
                definition_key INTEGER PRIMARY KEY,
                module TEXT NOT NULL,
                definition_file_path TEXT NOT NULL,
                definition_line INTEGER,
                definition_column INTEGER,
                definition_end_line INTEGER,
                definition_end_column INTEGER,
                module_port_count INTEGER NOT NULL,
                module_logic_count INTEGER NOT NULL,
                module_reg_count INTEGER NOT NULL,
                module_wire_count INTEGER NOT NULL,
                module_variable_count INTEGER NOT NULL,
                module_net_count INTEGER NOT NULL,
                module_signal_count INTEGER NOT NULL,
                module_variable_bits INTEGER NOT NULL,
                module_net_bits INTEGER NOT NULL,
                module_signal_bits INTEGER NOT NULL,
                module_internal_signal_count INTEGER NOT NULL,
                module_gen_signal_count INTEGER NOT NULL
            );

            CREATE TABLE definition_signal_stats (
                definition_key INTEGER NOT NULL,
                signal_name TEXT NOT NULL,
                signal_kind TEXT NOT NULL,
                signal_count INTEGER NOT NULL,
                total_bits INTEGER NOT NULL
            );

            CREATE INDEX idx_instances_parent_path ON instances(parent_path);
            CREATE INDEX idx_instances_module ON instances(module);
            CREATE INDEX idx_instances_definition_key ON instances(definition_key);
            CREATE INDEX idx_def_signal_stats_definition_key ON definition_signal_stats(definition_key);
            CREATE INDEX idx_def_signal_stats_signal_name ON definition_signal_stats(signal_name);
        """)

        connection.executemany(
            "INSERT INTO meta(key, value) VALUES(?, ?)",
            [
                ("format", "hier-viewer-sqlite"),
                ("schema_version", "2"),
                ("instance_count", str(len(filtered_entries))),
                ("definition_count", str(len(definition_representatives))),
            ],
        )

        connection.executemany(
            """
            INSERT INTO instances(
                path, parent_path, instance_name, module, definition_key, file_path, line, column,
                end_line, end_column, definition_file_path, definition_line,
                definition_column, definition_end_line, definition_end_column,
                module_port_count, module_logic_count, module_reg_count,
                module_wire_count, module_variable_count, module_net_count,
                module_signal_count, module_variable_bits, module_net_bits,
                module_signal_bits, module_internal_signal_count, module_gen_signal_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    entry.path,
                    entry.path.rpartition('.')[0] or None,
                    entry.path.split('.')[-1],
                    entry.module,
                    instance_definition_keys.get(entry.path),
                    entry.file_path,
                    entry.line,
                    entry.column,
                    entry.end_line,
                    entry.end_column,
                    entry.definition_file_path,
                    entry.definition_line,
                    entry.definition_column,
                    entry.definition_end_line,
                    entry.definition_end_column,
                    entry.module_port_count,
                    entry.module_logic_count,
                    entry.module_reg_count,
                    entry.module_wire_count,
                    entry.module_variable_count,
                    entry.module_net_count,
                    entry.module_signal_count,
                    entry.module_variable_bits,
                    entry.module_net_bits,
                    entry.module_signal_bits,
                    entry.module_internal_signal_count,
                    entry.module_gen_signal_count,
                )
                for entry in sorted(filtered_entries, key=lambda item: item.path)
            ],
        )

        connection.executemany(
            """
            INSERT INTO definitions(
                definition_key, module, definition_file_path, definition_line,
                definition_column, definition_end_line, definition_end_column,
                module_port_count, module_logic_count, module_reg_count,
                module_wire_count, module_variable_count, module_net_count,
                module_signal_count, module_variable_bits, module_net_bits,
                module_signal_bits, module_internal_signal_count, module_gen_signal_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    definition_key,
                    representative.module,
                    representative.definition_file_path,
                    representative.definition_line,
                    representative.definition_column,
                    representative.definition_end_line,
                    representative.definition_end_column,
                    representative.definition_shape.port_count,
                    representative.definition_shape.logic_count,
                    representative.definition_shape.reg_count,
                    representative.definition_shape.wire_count,
                    signal_summary.variable_count,
                    signal_summary.net_count,
                    signal_summary.signal_count,
                    signal_summary.variable_bits,
                    signal_summary.net_bits,
                    signal_summary.signal_bits,
                    signal_summary.internal_signal_count,
                    signal_summary.gen_signal_count,
                )
                for definition_key, representative in sorted(definition_representatives.items())
                if (signal_summary := definition_signal_cache.get(definition_key)) is not None
            ],
        )

        definition_signal_stat_rows: List[Tuple[object, ...]] = []
        for definition_key in sorted(definition_representatives):
            signal_summary = definition_signal_cache.get(definition_key)
            if signal_summary is None:
                continue

            for signal_stat in signal_summary.signal_stats:
                definition_signal_stat_rows.append((
                    definition_key,
                    signal_stat.signal_name,
                    signal_stat.signal_kind,
                    signal_stat.signal_count,
                    signal_stat.total_bits,
                ))

        if definition_signal_stat_rows:
            connection.executemany(
                """
                INSERT INTO definition_signal_stats(
                    definition_key, signal_name, signal_kind, signal_count, total_bits
                ) VALUES (?, ?, ?, ?, ?)
                """,
                definition_signal_stat_rows,
            )

        connection.commit()
    finally:
        connection.close()


# ============================================================================
# HIERARCHY DIRECTORY GENERATION
# ============================================================================

def generate_hierarchy_directory(hierarchy_data: List[Tuple[str, str]],
                                  output_dir: str,
                                  config: Optional[ViewerConfig] = None) -> None:
    """
    Generate directory structure representing the hierarchy.

    Directory Structure:
    ====================
        output_dir/
        ├── .moduleName          # Root module name
        ├── submod1/
        │   ├── .moduleName      # submod1's module name
        │   ├── leaf1            # File: hieraPath + moduleName
        │   └── grandchild/
        │       ├── .moduleName
        │       └── leaf2        # File: hieraPath + moduleName
        └── submod2              # Leaf: File with hieraPath + moduleName

    Algorithm:
    ==========
        1. Filter excluded modules
        2. Build tree structure from hierarchy data
        3. Recursively create directories and files:
           - For nodes with children: create directory + .moduleName file
           - For leaf nodes: create file with content

    Args:
        hierarchy_data: List of (hierarchicalPath, moduleName) tuples
        output_dir: Root directory path for output
        config: ViewerConfig for filtering options
    """
    import shutil

    if config is None:
        config = ViewerConfig()
    compiled_config = compile_viewer_config(config)

    # Filter excluded modules
    filtered_data = [
        (path, mod) for path, mod in hierarchy_data
        if not should_exclude_module_fast(mod, compiled_config)
    ]

    # Apply depth filter if specified
    if compiled_config.max_depth is not None:
        filtered_data = [
            (path, mod) for path, mod in filtered_data
            if path.count('.') < compiled_config.max_depth
        ]

    if not filtered_data:
        print(color_text("Warning: No hierarchy data to generate", Colors.YELLOW), file=sys.stderr)
        return

    # Build tree structure
    tree = build_hierarchy_tree(filtered_data)
    if tree is None:
        print(color_text("Warning: Failed to build hierarchy tree", Colors.YELLOW), file=sys.stderr)
        return

    # Create or clean output directory
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Recursively generate directory structure
    _generate_dir_recursive(tree, output_dir, tree.name)


def _generate_dir_recursive(node: HierarchyNode, current_path: str,
                            full_hier_path: str) -> None:
    """
    Recursively generate directory/file structure for a hierarchy node.

    Logic:
    ======
        ┌─────────────────────────────────────────────────────────────┐
        │  If node has children:                                      │
        │    - Create directory named after node                      │
        │    - Create .moduleName file with module type               │
        │    - Recursively process children                           │
        └──────────────────────────┬──────────────────────────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────────────┐
        │  If node is leaf (no children):                             │
        │    - Create file named after node                           │
        │    - File content: hieraPath and moduleName                 │
        └─────────────────────────────────────────────────────────────┘

    Args:
        node: Current HierarchyNode
        current_path: Current filesystem path
        full_hier_path: Full hierarchical path (e.g., "Top.sub.leaf")
    """
    import os

    node_path = os.path.join(current_path, node.name)

    if node.children:
        # Node has children -> create directory
        os.makedirs(node_path, exist_ok=True)

        # Create .moduleName file with module type
        module_name_file = os.path.join(node_path, ".moduleName")
        with open(module_name_file, 'w') as f:
            f.write(f"{node.module}\n")

        # Recursively process children
        for child in node.children:
            child_hier_path = f"{full_hier_path}.{child.name}"
            _generate_dir_recursive(child, node_path, child_hier_path)
    else:
        # Node is leaf -> create file
        with open(node_path, 'w') as f:
            f.write(f"hierarchicalPath: {full_hier_path}\n")
            f.write(f"moduleName: {node.module}\n")


def parse_custom_args(argv: List[str]) -> Tuple[ViewerConfig, Optional[str], str, List[str]]:
    """
    Parse custom command line arguments before passing to pyslang driver.

    Output modes (mutually exclusive):
    - -t / --tree: Generate ASCII tree view
    - -d / --dir: Generate directory structure
    - -p / --plain: Generate plain hierarchy path list
    - -c / --csv: Generate CSV hierarchy with source metadata
    - -s / --sqlite: Generate sqlite hierarchy database

    Custom args handled:
    - -o <file/path>: Output file for tree/plain/csv/sqlite, or directory path for --dir
    - -ncp / --no-compress-prefix: Disable compression
    - --depth <N>: Max depth
    - --exclude-wildcard <pattern>: Wildcard exclusion (repeatable)
    - --exclude-regex <pattern>: Regex exclusion (repeatable)

    Args:
        argv: Command line arguments (including script name)

    Returns:
        (config, output_path, mode, remaining_args_for_driver)
        mode is one of: 'tree', 'dir', 'plain', 'csv', 'sqlite'
    """
    config = ViewerConfig()
    output_path: Optional[str] = None
    mode: Optional[str] = None  # Will default to 'csv' if not specified
    args_for_driver = []

    i = 0
    while i < len(argv):
        arg = argv[i]

        if arg == '-o':
            if i + 1 < len(argv):
                output_path = argv[i + 1]
                i += 2
            else:
                print(color_text("Error: -o requires an output file/path argument", Colors.RED), file=sys.stderr)
                sys.exit(1)
        elif arg in ('-t', '--tree'):
            if mode is not None and mode != 'tree':
                print(color_text(f"Error: Cannot use --tree with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'tree'
            i += 1
        elif arg in ('-d', '--dir'):
            if mode is not None and mode != 'dir':
                print(color_text(f"Error: Cannot use --dir with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'dir'
            i += 1
        elif arg in ('-p', '--plain'):
            if mode is not None and mode != 'plain':
                print(color_text(f"Error: Cannot use --plain with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'plain'
            i += 1
        elif arg in ('-c', '--csv'):
            if mode is not None and mode != 'csv':
                print(color_text(f"Error: Cannot use --csv with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'csv'
            i += 1
        elif arg in ('-s', '--sqlite'):
            if mode is not None and mode != 'sqlite':
                print(color_text(f"Error: Cannot use --sqlite with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'sqlite'
            i += 1
        elif arg in ('-ncp', '--no-compress-prefix'):
            config.compress_prefix = False
            i += 1
        elif arg == '--depth':
            if i + 1 < len(argv):
                try:
                    config.max_depth = int(argv[i + 1])
                except ValueError:
                    print(color_text(f"Error: --depth requires an integer argument", Colors.RED), file=sys.stderr)
                    sys.exit(1)
                i += 2
            else:
                print(color_text("Error: --depth requires an argument", Colors.RED), file=sys.stderr)
                sys.exit(1)
        elif arg == '--exclude-wildcard':
            if i + 1 < len(argv):
                config.exclude_wildcards.append(argv[i + 1])
                i += 2
            else:
                print(color_text("Error: --exclude-wildcard requires a pattern argument", Colors.RED), file=sys.stderr)
                sys.exit(1)
        elif arg == '--exclude-regex':
            if i + 1 < len(argv):
                config.exclude_regexes.append(argv[i + 1])
                i += 2
            else:
                print(color_text("Error: --exclude-regex requires a pattern argument", Colors.RED), file=sys.stderr)
                sys.exit(1)
        # Handle legacy -od/--output-dir for backward compatibility (map to -d -o)
        elif arg in ('-od', '--output-dir'):
            if mode is not None and mode != 'dir':
                print(color_text(f"Error: Cannot use --output-dir with --{mode}. Choose one output mode.", Colors.RED), file=sys.stderr)
                sys.exit(1)
            mode = 'dir'
            if i + 1 < len(argv):
                output_path = argv[i + 1]
                i += 2
            else:
                print(color_text("Error: --output-dir requires a path argument", Colors.RED), file=sys.stderr)
                sys.exit(1)
        else:
            args_for_driver.append(arg)
            i += 1

    # Default to csv mode if not specified
    if mode is None:
        mode = 'csv'

    return config, output_path, mode, args_for_driver


def main():
    # Check for help flag first
    if '-h' in sys.argv or '--help' in sys.argv:
        print_help()
        return

    # Parse custom arguments
    config, output_path, mode, args_for_driver = parse_custom_args(sys.argv[1:])

    # Validate that file-based modes have output paths specified where required.
    if mode == 'dir' and output_path is None:
        print(color_text("Error: --dir mode requires -o <path> to specify output directory", Colors.RED), file=sys.stderr)
        sys.exit(1)
    if mode == 'sqlite' and output_path is None:
        print(color_text("Error: --sqlite mode requires -o <file> to specify the sqlite database path", Colors.RED), file=sys.stderr)
        sys.exit(1)

    driver = pyslang.Driver()
    driver.addStandardArgs()

    # Timescale mismatches are common in large vendor drops and don't affect the
    # hierarchy extraction flow we care about here, so keep them out of stderr.
    driver.diagEngine.setSeverity(
        pyslang.Diags.MissingTimeScale,
        pyslang.DiagnosticSeverity.Ignored,
    )
    driver.diagEngine.setSeverity(
        pyslang.Diags.MismatchedTimeScales,
        pyslang.DiagnosticSeverity.Ignored,
    )

    if "+define+SYNTHESIS" not in args_for_driver:
        args_for_driver.insert(0, "+define+SYNTHESIS")

    args = " ".join(args_for_driver)
    if not driver.parseCommandLine(args, pyslang.CommandLineOptions()):
        print(color_text("Error: failed to parse pyslang command line arguments.", Colors.RED), file=sys.stderr)
        return

    if not driver.processOptions():
        print(color_text("Error: failed while processing pyslang options.", Colors.RED), file=sys.stderr)
        return

    if not driver.parseAllSources():
        print(color_text("Error: failed while parsing source files.", Colors.RED), file=sys.stderr)
        return

    # Keep stdout clean for plain / CSV piping; only emit diagnostics on failure.
    if not driver.runFullCompilation(quiet=True):
        driver.reportDiagnostics(False)
        print(color_text("⚠ Warning: Compilation reported errors above. Analysis will continue with partial results.", Colors.YELLOW), file=sys.stderr)
        print(file=sys.stderr)

    compilation = driver.createCompilation()
    source_manager = driver.sourceManager

    def symbol_bit_width(symbol: object) -> int:
        declared_type = getattr(symbol, "declaredType", None)
        actual_type = getattr(declared_type, "type", None)
        if actual_type is None:
            return 0

        bitstream_width = getattr(actual_type, "bitstreamWidth", 0)
        if isinstance(bitstream_width, int):
            return max(0, bitstream_width)
        try:
            return max(0, int(bitstream_width))
        except Exception:
            return 0

    def collect_definition_shape(definition: object) -> ModuleMetrics:
        syntax = getattr(definition, "syntax", None)
        if syntax is None:
            return ModuleMetrics()

        port_count = 0
        logic_count = 0
        reg_count = 0
        wire_count = 0

        def count_declarators(node: object) -> int:
            if hasattr(node, "declarator"):
                return 1
            declarators = getattr(node, "declarators", None)
            if declarators is None:
                return 0
            return len(declarators)

        def classify_variable_type(type_node: object, declarator_count: int) -> None:
            nonlocal logic_count, reg_count
            type_text = str(type_node).strip()
            if type_text == "logic":
                logic_count += declarator_count
            elif type_text == "reg":
                reg_count += declarator_count

        def classify_port_header(header: object, declarator_count: int) -> None:
            nonlocal port_count, logic_count, reg_count, wire_count
            if declarator_count == 0 or header is None:
                return

            port_count += declarator_count
            header_kind = getattr(header, "kind", None)
            if header_kind == pyslang.SyntaxKind.VariablePortHeader:
                classify_variable_type(getattr(header, "dataType", ""), declarator_count)
            elif header_kind == pyslang.SyntaxKind.NetPortHeader:
                net_type_text = str(getattr(header, "netType", "")).strip()
                if net_type_text == "wire":
                    wire_count += declarator_count

        header_ports = getattr(getattr(syntax, "header", None), "ports", None)
        ports = getattr(header_ports, "ports", None)
        if ports is not None:
            for port in ports:
                if hasattr(port, "header"):
                    classify_port_header(port.header, count_declarators(port))

        for member in getattr(syntax, "members", []):
            kind = getattr(member, "kind", None)
            if kind == pyslang.SyntaxKind.DataDeclaration:
                classify_variable_type(getattr(member, "type", ""), count_declarators(member))
            elif kind == pyslang.SyntaxKind.NetDeclaration:
                declarator_count = count_declarators(member)
                net_type_text = str(getattr(member, "netType", "")).strip()
                if net_type_text == "wire":
                    wire_count += declarator_count
            elif kind == pyslang.SyntaxKind.PortDeclaration:
                classify_port_header(getattr(member, "header", None), count_declarators(member))

        return ModuleMetrics(
            port_count=port_count,
            logic_count=logic_count,
            reg_count=reg_count,
            wire_count=wire_count,
        )

    def iter_scope_members(scope: object) -> Iterable[object]:
        try:
            return iter(scope)
        except TypeError:
            pass

        body = getattr(scope, "body", None)
        if body is not None and body is not scope:
            try:
                return iter(body)
            except TypeError:
                pass

        members = getattr(scope, "members", None)
        if callable(members):
            try:
                return members()
            except TypeError:
                pass
        elif members is not None:
            try:
                return iter(members)
            except TypeError:
                pass

        return ()

    def original_location_details(location: object) -> Tuple[str, Optional[int], Optional[int]]:
        file_path = ""
        line: Optional[int] = None
        column: Optional[int] = None
        if location == pyslang.SourceLocation.NoLocation:
            return file_path, line, column

        original_loc = source_manager.getFullyOriginalLoc(location)
        if original_loc == pyslang.SourceLocation.NoLocation:
            return file_path, line, column

        file_path = str(source_manager.getFullPath(original_loc.buffer))
        line = source_manager.getLineNumber(original_loc)
        column = source_manager.getColumnNumber(original_loc)
        return file_path, line, column

    def original_range_end(source_range: object) -> Tuple[Optional[int], Optional[int]]:
        end_line: Optional[int] = None
        end_column: Optional[int] = None
        if source_range is None:
            return end_line, end_column

        original_range = source_manager.getFullyOriginalRange(source_range)
        if original_range.start == pyslang.SourceLocation.NoLocation:
            return end_line, end_column

        end_line = source_manager.getLineNumber(original_range.end)
        end_column = source_manager.getColumnNumber(original_range.end)
        return end_line, end_column

    def stable_definition_key(module_name: str,
                              definition_file_path: str,
                              definition_line: Optional[int],
                              definition_column: Optional[int]) -> int:
        raw = "\0".join([
            module_name,
            definition_file_path,
            "" if definition_line is None else str(definition_line),
            "" if definition_column is None else str(definition_column),
        ])
        digest = hashlib.blake2b(raw.encode("utf-8"), digest_size=8).digest()
        return int.from_bytes(digest, "big") & ((1 << 63) - 1)

    def collect_definition_signals(scope: object) -> DefinitionSignalSummary:
        if scope is None:
            return DefinitionSignalSummary()

        port_signal_paths = set()

        def collect_port_signal_paths(scope_node: object) -> None:
            for member in iter_scope_members(scope_node):
                if isinstance(member, pyslang.InstanceSymbol):
                    continue
                if isinstance(member, pyslang.PortSymbol):
                    lexical_path = str(getattr(member, "lexicalPath", ""))
                    if lexical_path:
                        port_signal_paths.add(lexical_path)
                    continue
                collect_port_signal_paths(member)

        collect_port_signal_paths(scope)

        variable_count = 0
        net_count = 0
        variable_bits = 0
        net_bits = 0
        internal_signal_count = 0
        gen_signal_count = 0
        signal_name_stats: Dict[Tuple[str, str], List[int]] = defaultdict(lambda: [0, 0])

        def collect_signal_members(scope_node: object) -> None:
            nonlocal variable_count, net_count, variable_bits, net_bits
            nonlocal internal_signal_count, gen_signal_count

            for member in iter_scope_members(scope_node):
                if isinstance(member, pyslang.InstanceSymbol):
                    continue
                if isinstance(member, pyslang.PortSymbol):
                    continue

                signal_kind: Optional[str] = None
                if isinstance(member, pyslang.VariableSymbol):
                    signal_kind = "variable"
                    variable_count += 1
                elif isinstance(member, pyslang.NetSymbol):
                    signal_kind = "net"
                    net_count += 1

                if signal_kind is not None:
                    bit_width = symbol_bit_width(member)
                    lexical_path = str(getattr(member, "lexicalPath", ""))
                    is_port = lexical_path in port_signal_paths

                    if signal_kind == "variable":
                        variable_bits += bit_width
                    else:
                        net_bits += bit_width

                    if not is_port:
                        internal_signal_count += 1
                        signal_name = str(getattr(member, "name", ""))
                        if signal_name.startswith("_GEN"):
                            gen_signal_count += 1
                        aggregate = signal_name_stats[(signal_name, signal_kind)]
                        aggregate[0] += 1
                        aggregate[1] += bit_width
                    continue

                collect_signal_members(member)

        collect_signal_members(scope)

        return DefinitionSignalSummary(
            variable_count=variable_count,
            net_count=net_count,
            signal_count=variable_count + net_count,
            variable_bits=variable_bits,
            net_bits=net_bits,
            signal_bits=variable_bits + net_bits,
            internal_signal_count=internal_signal_count,
            gen_signal_count=gen_signal_count,
            signal_stats=tuple(
                sorted(
                    [
                        DefinitionSignalStatSummary(
                            signal_name=signal_name,
                            signal_kind=signal_kind,
                            signal_count=count_bits[0],
                            total_bits=count_bits[1],
                        )
                        for (signal_name, signal_kind), count_bits in signal_name_stats.items()
                    ],
                    key=lambda item: (item.signal_name, item.signal_kind),
                )
            ),
        )

    class HierarchyCollector:
        def __init__(self):
            self.hierarchy_data: List[Tuple[str, str]] = []
            self.hierarchy_entries: List[HierarchyEntry] = []
            self.instance_metadata: List[InstanceMetadata] = []
            self.definition_shape_cache: Dict[int, ModuleMetrics] = {}
            self.definition_signal_cache: Dict[int, DefinitionSignalSummary] = {}

        def finalize_entries(self) -> None:
            self.hierarchy_entries = []
            for instance in self.instance_metadata:
                signal_summary = (
                    self.definition_signal_cache.get(instance.definition_key)
                    if instance.definition_key is not None
                    else None
                ) or DefinitionSignalSummary()
                self.hierarchy_entries.append(HierarchyEntry(
                    path=instance.path,
                    module=instance.module,
                    file_path=instance.file_path,
                    line=instance.line,
                    column=instance.column,
                    end_line=instance.end_line,
                    end_column=instance.end_column,
                    definition_file_path=instance.definition_file_path,
                    definition_line=instance.definition_line,
                    definition_column=instance.definition_column,
                    definition_end_line=instance.definition_end_line,
                    definition_end_column=instance.definition_end_column,
                    module_port_count=instance.definition_shape.port_count,
                    module_logic_count=instance.definition_shape.logic_count,
                    module_reg_count=instance.definition_shape.reg_count,
                    module_wire_count=instance.definition_shape.wire_count,
                    module_variable_count=signal_summary.variable_count,
                    module_net_count=signal_summary.net_count,
                    module_signal_count=signal_summary.signal_count,
                    module_variable_bits=signal_summary.variable_bits,
                    module_net_bits=signal_summary.net_bits,
                    module_signal_bits=signal_summary.signal_bits,
                    module_internal_signal_count=signal_summary.internal_signal_count,
                    module_gen_signal_count=signal_summary.gen_signal_count,
                ))

        def append_instance(self, node: object) -> None:
            hier_path = node.hierarchicalPath
            module_name = node.definition.name if node.definition else node.name
            self.hierarchy_data.append((hier_path, module_name))

            file_path = ""
            line: Optional[int] = None
            column: Optional[int] = None
            end_line: Optional[int] = None
            end_column: Optional[int] = None
            definition_file_path = ""
            definition_line: Optional[int] = None
            definition_column: Optional[int] = None
            definition_end_line: Optional[int] = None
            definition_end_column: Optional[int] = None
            definition_shape = ModuleMetrics()
            definition_key: Optional[int] = None

            file_path, line, column = original_location_details(node.location)

            syntax = getattr(node, "syntax", None)
            source_range = getattr(syntax, "sourceRange", None)
            end_line, end_column = original_range_end(source_range)

            definition = getattr(node, "definition", None)
            definition_file_path, definition_line, definition_column = original_location_details(
                getattr(definition, "location", pyslang.SourceLocation.NoLocation)
            )

            definition_syntax = getattr(definition, "syntax", None)
            definition_range = getattr(definition_syntax, "sourceRange", None)
            definition_end_line, definition_end_column = original_range_end(definition_range)

            if definition is not None:
                definition_key = stable_definition_key(
                    module_name,
                    definition_file_path,
                    definition_line,
                    definition_column,
                )
                if definition_key not in self.definition_shape_cache:
                    self.definition_shape_cache[definition_key] = collect_definition_shape(definition)
                if definition_key not in self.definition_signal_cache:
                    self.definition_signal_cache[definition_key] = collect_definition_signals(
                        getattr(node, "body", None)
                    )
                definition_shape = self.definition_shape_cache[definition_key]

            self.instance_metadata.append(InstanceMetadata(
                path=hier_path,
                module=module_name,
                definition_key=definition_key,
                file_path=file_path,
                line=line,
                column=column,
                end_line=end_line,
                end_column=end_column,
                definition_file_path=definition_file_path,
                definition_line=definition_line,
                definition_column=definition_column,
                definition_end_line=definition_end_line,
                definition_end_column=definition_end_column,
                definition_shape=definition_shape,
            ))

        def collect_child_instances(self, scope: object) -> None:
            for member in iter_scope_members(scope):
                if isinstance(member, pyslang.InstanceSymbol):
                    self.collect_instance(member)
                else:
                    self.collect_child_instances(member)

        def collect_instance(self, node: object) -> None:
            self.append_instance(node)
            body = getattr(node, "body", None)
            if body is None:
                return
            self.collect_child_instances(body)

    visitor = HierarchyCollector()
    for top_instance in getattr(compilation.getRoot(), "topInstances", []):
        visitor.collect_instance(top_instance)
    visitor.finalize_entries()

    # Execute mode-specific output generation
    if mode == 'dir':
        assert output_path is not None  # Validated above
        generate_hierarchy_directory(visitor.hierarchy_data, output_path, config)
        print(f"Hierarchy directory structure generated at: {output_path}")
    elif mode == 'tree':
        if output_path:
            with open(output_path, 'w') as f:
                generate_ascii_tree(visitor.hierarchy_data, f, config)
            print(f"ASCII tree written to: {output_path}")
        else:
            generate_ascii_tree(visitor.hierarchy_data, sys.stdout, config)
    elif mode == 'plain':
        if output_path:
            with open(output_path, 'w') as f:
                generate_plain_hierarchy(visitor.hierarchy_data, f, config)
            print(f"Plain hierarchy written to: {output_path}")
        else:
            generate_plain_hierarchy(visitor.hierarchy_data, sys.stdout, config)
    elif mode == 'csv':
        if output_path:
            with open(output_path, 'w', newline='') as f:
                generate_csv_hierarchy(visitor.hierarchy_entries, f, config)
            print(f"CSV hierarchy written to: {output_path}")
        else:
            generate_csv_hierarchy(visitor.hierarchy_entries, sys.stdout, config)
    elif mode == 'sqlite':
        assert output_path is not None
        generate_sqlite_hierarchy(
            visitor.hierarchy_entries,
            visitor.instance_metadata,
            visitor.definition_signal_cache,
            output_path,
            config,
        )
        print(f"SQLite hierarchy written to: {output_path}")

if __name__ == "__main__":
    main()
