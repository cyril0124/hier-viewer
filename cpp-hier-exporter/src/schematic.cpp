#include "schematic.h"

#include <algorithm>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <sqlite3.h>

#include "slang/ast/ASTVisitor.h"
#include "slang/ast/Compilation.h"
#include "slang/ast/EvalContext.h"
#include "slang/ast/symbols/CompilationUnitSymbols.h"
#include "slang/syntax/AllSyntax.h"

namespace hier {
namespace {
using namespace slang;
using namespace slang::ast;

// Rows are accumulated in memory and written in large per-table batches.
// SQLite allocates pages as rows arrive, so inserting every scope into all four
// tables at once spreads each table's pages across the whole file. Scattered
// pages defeat readahead and make a later full scan an order of magnitude
// slower, so each table is written in long contiguous runs instead.
constexpr size_t BATCH_BYTES = 32u << 20;
constexpr uint32_t NUMBER_FIELD = 1u << 31;

class Insert {
public:
    Insert(sqlite3* db, const char* sql) : db(db) {
        if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
            throw std::runtime_error(sqlite3_errmsg(db));
    }
    ~Insert() { sqlite3_finalize(stmt); }
    Insert(const Insert&) = delete;
    Insert& operator=(const Insert&) = delete;

    void text(int column, std::string_view value) {
        append(uint32_t(column), uint32_t(value.size()), value.data(), value.size());
    }
    void number(int column, uint64_t value) {
        append(uint32_t(column), NUMBER_FIELD, &value, sizeof(value));
    }
    void run() {
        rowFields.push_back(pending);
        pending = 0;
        ++rows;
        if (batch.size() >= BATCH_BYTES)
            flush();
    }
    void finish() {
        if (rows != 0)
            flush();
    }
private:
    sqlite3* db;
    sqlite3_stmt* stmt = nullptr;
    std::vector<char> batch;
    // A row may bind fewer columns than its table has, for example a NULL
    // instance_path, so the field count travels with each buffered row.
    std::vector<uint32_t> rowFields;
    uint32_t pending = 0;
    size_t rows = 0;

    void append(uint32_t column, uint32_t header, const void* data, size_t size) {
        ++pending;
        const size_t offset = batch.size();
        batch.resize(offset + 2 * sizeof(uint32_t) + size);
        std::memcpy(batch.data() + offset, &column, sizeof(column));
        std::memcpy(batch.data() + offset + sizeof(column), &header, sizeof(header));
        if (size != 0)
            std::memcpy(batch.data() + offset + sizeof(column) + sizeof(header), data, size);
    }

    void flush() {
        size_t cursor = 0;
        for (size_t row = 0; row < rows; ++row) {
            for (uint32_t field = 0; field < rowFields[row]; ++field) {
                uint32_t column = 0;
                uint32_t header = 0;
                std::memcpy(&column, batch.data() + cursor, sizeof(column));
                cursor += sizeof(column);
                std::memcpy(&header, batch.data() + cursor, sizeof(header));
                cursor += sizeof(header);
                if (header & NUMBER_FIELD) {
                    uint64_t value = 0;
                    std::memcpy(&value, batch.data() + cursor, sizeof(value));
                    cursor += sizeof(value);
                    check(sqlite3_bind_int64(stmt, int(column), sqlite3_int64(value)));
                }
                else {
                    check(sqlite3_bind_text(stmt, int(column), batch.data() + cursor,
                                            int(header), SQLITE_TRANSIENT));
                    cursor += header;
                }
            }
            check(sqlite3_step(stmt));
            check(sqlite3_reset(stmt));
            check(sqlite3_clear_bindings(stmt));
        }
        batch.clear();
        rowFields.clear();
        rows = 0;
    }

    void check(int result) {
        if (result != SQLITE_OK && result != SQLITE_DONE)
            throw std::runtime_error(sqlite3_errmsg(db));
    }
};

struct SchematicInserts {
    Insert node, port, net, endpoint;
    explicit SchematicInserts(sqlite3* db) :
        node(db, "INSERT INTO schematic_nodes VALUES(?1,?2,?3,?4,?5,?6)"),
        port(db, "INSERT INTO schematic_ports VALUES(?1,?2,?3,?4,?5,?6,?7)"),
        net(db, "INSERT INTO schematic_nets VALUES(?1,?2,?3,?4,?5)"),
        endpoint(db, "INSERT INTO schematic_endpoints VALUES(?1,?2,?3,?4,?5)") {}

    void finish() {
        node.finish();
        port.finish();
        net.finish();
        endpoint.finish();
    }
};

struct Net {
    std::string id;
    std::string name;
    uint64_t width;
    size_t drivers = 0;
    bool bidirectional = false;
    bool unresolved = false;
    bool multiDriver = false;
    SmallVector<ConstantRange, 2> driverRanges;
};

std::string directionOf(const Symbol& symbol) {
    ArgumentDirection direction;
    if (symbol.kind == SymbolKind::Port)
        direction = symbol.as<PortSymbol>().direction;
    else if (symbol.kind == SymbolKind::MultiPort)
        direction = symbol.as<MultiPortSymbol>().direction;
    else
        return "unknown";
    switch (direction) {
        case ArgumentDirection::In: return "input";
        case ArgumentDirection::Out: return "output";
        case ArgumentDirection::InOut: return "inout";
        case ArgumentDirection::Ref: return "ref";
    }
    return "unknown";
}

uint64_t portWidth(const Symbol& symbol) {
    if (symbol.kind == SymbolKind::Port)
        return symbol.as<PortSymbol>().getType().getBitstreamWidth();
    if (symbol.kind == SymbolKind::MultiPort)
        return symbol.as<MultiPortSymbol>().getType().getBitstreamWidth();
    return 0;
}

std::string endpointRole(std::string_view direction, bool boundary) {
    if (direction == "input") return boundary ? "driver" : "sink";
    if (direction == "output") return boundary ? "sink" : "driver";
    if (direction == "inout") return "bidirectional";
    return "unknown";
}

std::string expressionText(const Expression& expr) {
    if (expr.syntax) return expr.syntax->toString();
    return std::string(toString(expr.kind));
}

// Invoke a callback only for immediate expression children, without descending
// into function bodies or turning semantic dependencies into synthesized gates.
struct ExpressionChildVisitor {
    std::function<void(const Expression&)> callback;
    template<typename T> void visit(const T& item) {
        if constexpr (std::is_base_of_v<Expression, T>) callback(item);
    }
};

struct ExpressionChildren {
    ExpressionChildVisitor& children;
    template<typename T> void visit(const T& item) {
        if constexpr (requires { item.visitExprs(children); }) item.visitExprs(children);
    }
};

class ScopeGraph {
public:
    ScopeGraph(SchematicInserts& inserts, const InstanceSymbol& instance,
               const std::set<std::string>& allowedPaths, bool incomplete) :
        instance(instance), path(instance.getHierarchicalPath()), allowedPaths(allowedPaths),
        incomplete(incomplete),
        nodeInsert(inserts.node), portInsert(inserts.port), netInsert(inserts.net),
        endpointInsert(inserts.endpoint) {
        // Canonical expressions can refer to a different concrete ancestor.
        // Rebase only those ancestor bodies, preserving unrelated hierarchical references.
        const InstanceSymbol* current = &instance;
        while (current) {
            if (const auto* canonical = current->getCanonicalBody()) {
                if (canonical->parentInstance)
                    rebases.emplace_back(canonical->parentInstance->getHierarchicalPath(),
                                         current->getHierarchicalPath());
            }
            current = parentInstance(*current);
        }
    }

    void collect() {
        if (incomplete) {
            addNode(path + ":elaboration-errors", "unresolved", "Elaboration errors",
                    "slang reported compilation errors. This graph may be incomplete; resolve the exporter diagnostics and regenerate from RTL.");
        }
        size_t ordinal = 0;
        const auto boundaryNode = path + ":boundary";
        if (!instance.body.getPortList().empty()) {
            addNode(boundaryNode, "boundary", "boundary", "Scope boundary ports");
        }
        for (const auto* port : instance.body.getPortList()) {
            const auto node = boundaryNode;
            const auto direction = directionOf(*port);
            const auto portId = "p:" + std::to_string(ordinal);
            addPort(node, portId, std::string(port->name), direction, portWidth(*port), ordinal++);
            const auto role = endpointRole(direction, true);
            if (port->kind == SymbolKind::Port) {
                const auto& value = port->as<PortSymbol>();
                if (value.internalSymbol && ValueSymbol::isKind(value.internalSymbol->kind)) {
                    endpoint(symbolNet(*value.internalSymbol), node, portId, role);
                    continue;
                }
                if (const auto* expr = value.getInternalExpr()) {
                    connect(*expr, node, portId, role);
                    continue;
                }
            }
            missing(node, portId, portWidth(*port), "Unsupported or absent internal port connection");
        }
        collectMembers(instance.body);
        for (const auto& net : nets) {
            netInsert.text(1, path);
            netInsert.text(2, net.id);
            netInsert.text(3, net.name);
            netInsert.number(4, net.width);
            std::string_view status = "resolved";
            if (net.bidirectional) status = "bidirectional";
            else if (net.multiDriver) status = "multi-driver";
            else if (net.unresolved || !net.drivers) status = "unresolved";
            netInsert.text(5, status);
            netInsert.run();
        }
    }

private:
    const InstanceSymbol& instance;
    std::string path;
    const std::set<std::string>& allowedPaths;
    bool incomplete;
    std::vector<std::pair<std::string, std::string>> rebases;
    Insert &nodeInsert, &portInsert, &netInsert, &endpointInsert;
    std::vector<Net> nets;
    std::unordered_map<std::string, size_t> netIndices;
    std::unordered_set<std::string> nodeIds;
    size_t sequence = 0;

    static const InstanceSymbol* parentInstance(const InstanceSymbol& child) {
        for (auto* scope = child.getParentScope(); scope; scope = scope->asSymbol().getParentScope()) {
            if (scope->asSymbol().kind == SymbolKind::InstanceBody)
                return scope->asSymbol().as<InstanceBodySymbol>().parentInstance;
        }
        return nullptr;
    }

    std::string concretePath(const Symbol& symbol) const {
        auto result = symbol.getHierarchicalPath();
        for (const auto& [source, target] : rebases) {
            if (result == source || (result.starts_with(source) && result.size() > source.size() &&
                                     result[source.size()] == '.'))
                return target + result.substr(source.size());
        }
        return result;
    }

    std::string fresh(std::string_view kind) {
        // Node identities are already scoped by scope_path in every table.
        // Repeating the full hierarchy path here multiplies it across ports,
        // nets, endpoints and their indexes.
        return std::string(kind) + ":" + std::to_string(sequence++);
    }

    void addNode(const std::string& id, std::string_view kind, const std::string& label,
                 const std::string& detail, const std::string& instancePath = {}) {
        if (!nodeIds.insert(id).second) {
            throw std::runtime_error("duplicate schematic node in scope '" + path + "': " + id);
        }
        nodeInsert.text(1, path);
        nodeInsert.text(2, id);
        nodeInsert.text(3, kind);
        nodeInsert.text(4, label);
        if (!instancePath.empty()) nodeInsert.text(5, instancePath);
        nodeInsert.text(6, detail);
        nodeInsert.run();
    }

    void addPort(const std::string& node, const std::string& id, const std::string& name,
                 std::string_view direction, uint64_t width, size_t ordinal) {
        portInsert.text(1, path);
        portInsert.text(2, node);
        portInsert.text(3, id);
        portInsert.text(4, name);
        portInsert.text(5, direction);
        portInsert.number(6, width);
        portInsert.number(7, ordinal);
        portInsert.run();
    }

    size_t addNet(std::string id, std::string name, uint64_t width, bool unresolved = false) {
        auto [it, inserted] = netIndices.try_emplace(id, nets.size());
        if (inserted) nets.push_back({std::move(id), std::move(name), width, 0, false, unresolved, false, {}});
        return it->second;
    }

    size_t symbolNet(const Symbol& symbol) {
        const auto id = concretePath(symbol);
        uint64_t width = 0;
        if (ValueSymbol::isKind(symbol.kind)) width = symbol.as<ValueSymbol>().getType().getBitstreamWidth();
        const auto displayName = id.starts_with(path + ".") ? id.substr(path.size() + 1) : id;
        return addNet("net:" + id, displayName, width, width == 0);
    }

    void endpoint(size_t index, const std::string& node, const std::string& port,
                  std::string_view role, std::optional<ConstantRange> range = {}) {
        auto& net = nets[index];
        if (role == "driver") {
            const auto driven = range.value_or(ConstantRange(int32_t(net.width ? net.width - 1 : 0), 0));
            for (const auto& previous : net.driverRanges) {
                if (driven.lower() <= previous.upper() && previous.lower() <= driven.upper())
                    net.multiDriver = true;
            }
            net.driverRanges.push_back(driven);
            ++net.drivers;
        }
        net.bidirectional |= role == "bidirectional";
        net.unresolved |= role == "unknown";
        endpointInsert.text(1, path);
        endpointInsert.text(2, net.id);
        endpointInsert.text(3, node);
        endpointInsert.text(4, port);
        endpointInsert.text(5, role);
        endpointInsert.run();
    }

    void missing(const std::string& node, const std::string& port, uint64_t width,
                 const std::string& detail) {
        const auto id = fresh("unresolved");
        addNode(id, "unresolved", "Unresolved", detail);
        addPort(id, "p", "connection", "unknown", width, 0);
        const auto net = addNet(id + ":net", detail, width, true);
        endpoint(net, id, "p", "unknown");
        endpoint(net, node, port, "unknown");
    }

    std::optional<ConstantRange> lvalueSelection(const Expression& expr) const {
        const Expression* base = nullptr;
        if (expr.kind == ExpressionKind::RangeSelect) base = &expr.as<RangeSelectExpression>().value();
        if (expr.kind == ExpressionKind::ElementSelect) base = &expr.as<ElementSelectExpression>().value();
        if (expr.kind == ExpressionKind::MemberAccess) base = &expr.as<MemberAccessExpression>().value();
        if (!base || !base->type->isIntegral() ||
            (base->kind != ExpressionKind::NamedValue && base->kind != ExpressionKind::HierarchicalValue))
            return {};
        if (expr.kind == ExpressionKind::MemberAccess) {
            const auto& member = expr.as<MemberAccessExpression>().member;
            if (member.kind != SymbolKind::Field) return {};
            const auto offset = member.as<FieldSymbol>().bitOffset;
            return ConstantRange(int32_t(offset + expr.type->getBitstreamWidth() - 1), int32_t(offset));
        }
        EvalContext context(ASTContext(instance.body, LookupLocation::max));
        return expr.evalSelector(context, false);
    }

    // A driver flows into an lvalue expression (slice / concatenation). Its
    // data operands flow outward; selector operands remain read dependencies.
    void connect(const Expression& expression, const std::string& node,
                 const std::string& port, std::string_view role,
                 std::optional<ConstantRange> drivenRange = {}, size_t depth = 0) {
        const Expression* expr = &expression;
        if (expr->kind == ExpressionKind::Assignment && expr->as<AssignmentExpression>().isLValueArg())
            expr = &expr->as<AssignmentExpression>().left();
        if (expr->kind == ExpressionKind::NamedValue || expr->kind == ExpressionKind::HierarchicalValue) {
            const auto* symbol = expr->getSymbolReference();
            if (symbol && symbol->kind != SymbolKind::Parameter && symbol->kind != SymbolKind::EnumValue) {
                endpoint(symbolNet(*symbol), node, port, role, drivenRange);
                return;
            }
        }

        const auto width = expr->type->getBitstreamWidth();
        const auto id = fresh("expr");
        const auto text = depth == 0 ? expressionText(*expr) : std::string();
        const auto* constant = expr->getConstant();
        const bool isConstant = constant && bool(*constant);
        const bool writing = role == "driver";
        const bool bidirectional = role == "bidirectional";
        const bool partialWrite = writing && (expr->kind == ExpressionKind::RangeSelect ||
            expr->kind == ExpressionKind::ElementSelect || expr->kind == ExpressionKind::MemberAccess);
        const auto selectedRange = partialWrite ? lvalueSelection(*expr) : std::optional<ConstantRange>{};
        const bool supportedKind = isConstant || expr->kind == ExpressionKind::UnaryOp ||
            expr->kind == ExpressionKind::BinaryOp || expr->kind == ExpressionKind::ConditionalOp ||
            expr->kind == ExpressionKind::Concatenation || expr->kind == ExpressionKind::Replication ||
            expr->kind == ExpressionKind::ElementSelect || expr->kind == ExpressionKind::RangeSelect ||
            expr->kind == ExpressionKind::MemberAccess || expr->kind == ExpressionKind::Conversion ||
            expr->kind == ExpressionKind::IntegerLiteral || expr->kind == ExpressionKind::UnbasedUnsizedIntegerLiteral;
        const bool supported = supportedKind && (!partialWrite || selectedRange.has_value());
        std::string kind = supported ? "expr" : "unresolved";
        if (isConstant) kind = "constant";
        const auto expressionKind = std::string(toString(expr->kind));
        std::string detail = expressionKind + ": ";
        // Keep the complete expression at the connection root. Nested
        // expressions repeat their parent text almost in full, so retain their
        // topology and a stable parent reference instead of another full copy.
        if (depth == 0) detail += text;
        else detail += "operand of " + node;
        if (isConstant) detail += " = " + constant->toString();
        if (!supported) detail = "Unsupported semantic expression: " + detail;
        if (partialWrite && !selectedRange)
            detail += "; exact bit mapping unavailable for nested, dynamic or unpacked write";
        addNode(id, kind, expressionKind, detail);
        addPort(id, "value", "value", bidirectional ? "inout" : writing ? "input" : "output", width, 0);
        const auto net = addNet(id + ":value", "value", width, !supported);
        endpoint(net, node, port, role);
        endpoint(net, id, "value", bidirectional ? "bidirectional" : writing ? "sink" : "driver");
        if (isConstant) return;

        size_t ordinal = 0;
        ExpressionChildVisitor children{[&](const Expression& child) {
            const auto childPort = "operand:" + std::to_string(ordinal);
            bool dataOperand = expr->kind == ExpressionKind::Concatenation ||
                               expr->kind == ExpressionKind::Conversion || ordinal == 0;
            std::string_view childRole = "sink";
            if (dataOperand && writing) childRole = "driver";
            if (dataOperand && bidirectional) childRole = "bidirectional";
            if (!supported || role == "unknown") childRole = "unknown";
            addPort(id, childPort, childPort,
                    childRole == "driver" ? "output" : childRole == "bidirectional" ? "inout" : "input",
                    child.type->getBitstreamWidth(), ordinal + 1);
            // Slang normalizes direct packed selections into storage offsets.
            // Nested, dynamic and unpacked writes retain unknown dependencies.
            ++ordinal;
            connect(child, id, childPort, childRole, dataOperand ? selectedRange : std::nullopt,
                    depth + 1);
        }};
        ExpressionChildren visitor{children};
        expr->visit(visitor);
    }

    void childInstance(const InstanceSymbol& child) {
        const auto id = concretePath(child);
        std::string detail(child.getDefinition().name);
        for (const auto* parameter : child.body.getParameters()) {
            if (parameter->symbol.kind == SymbolKind::Parameter)
                detail += "\n" + std::string(parameter->symbol.name) + " = " +
                          parameter->symbol.as<ParameterSymbol>().getValue().toString();
        }
        const bool visible = allowedPaths.contains(id);
        if (!visible) detail = "Instance excluded by hierarchy filters: " + id + "\n" + detail;
        addNode(id, visible ? "module" : "unresolved", id.substr(path.size() + 1), detail,
                visible ? id : std::string());
        const auto connections = child.getPortConnections();
        size_t ordinal = 0;
        for (const auto* port : child.body.getPortList()) {
            const auto portId = "p:" + std::to_string(ordinal);
            const auto direction = directionOf(*port);
            const auto width = portWidth(*port);
            addPort(id, portId, std::string(port->name), direction, width, ordinal);
            const PortConnection* connection = ordinal < connections.size() ? connections[ordinal] : nullptr;
            ++ordinal;
            if (connection && port->kind == SymbolKind::InterfacePort) {
                const auto [connected, modport] = connection->getIfaceConn();
                if (connected) {
                    const auto unresolved = fresh("interface");
                    auto detail = "Unsupported interface signal expansion: " + concretePath(*connected);
                    if (modport) detail += "." + std::string(modport->name);
                    addNode(unresolved, "unresolved", std::string(port->name), detail);
                    addPort(unresolved, "p", "interface", "unknown", 0, 0);
                    const auto net = symbolNet(*connected);
                    endpoint(net, id, portId, "unknown");
                    endpoint(net, unresolved, "p", "unknown");
                    continue;
                }
            }
            if (connection && port->kind != SymbolKind::InterfacePort) {
                if (const auto* expr = connection->getExpression()) {
                    connect(*expr, id, portId, endpointRole(direction, false));
                    continue;
                }
            }
            missing(id, portId, width, port->kind == SymbolKind::InterfacePort ?
                    "Unsupported interface port connection: " + std::string(port->name) :
                    "Unconnected port: " + std::string(port->name));
        }
    }

    void assignment(const Expression& expr) {
        if (expr.kind != ExpressionKind::Assignment) {
            addNode(fresh("unresolved"), "unresolved", "Assignment", "Unsupported continuous assignment: " + expressionText(expr));
            return;
        }
        const auto& assignment = expr.as<AssignmentExpression>();
        const auto id = fresh("assign");
        addNode(id, "expr", "assign", "Continuous assignment dependency: " + expressionText(expr));
        addPort(id, "rhs", "rhs", "input", assignment.right().type->getBitstreamWidth(), 0);
        addPort(id, "lhs", "lhs", "output", assignment.left().type->getBitstreamWidth(), 1);
        connect(assignment.right(), id, "rhs", "sink");
        connect(assignment.left(), id, "lhs", "driver");
    }

    void collectMembers(const Scope& scope) {
        for (const auto& member : scope.members()) {
            switch (member.kind) {
                case SymbolKind::Instance: childInstance(member.as<InstanceSymbol>()); break;
                case SymbolKind::GenerateBlock:
                    if (!member.as<GenerateBlockSymbol>().isUninstantiated) collectMembers(member.as<Scope>());
                    break;
                case SymbolKind::GenerateBlockArray:
                case SymbolKind::InstanceArray: collectMembers(member.as<Scope>()); break;
                case SymbolKind::ContinuousAssign: assignment(member.as<ContinuousAssignSymbol>().getAssignment()); break;
                case SymbolKind::ProceduralBlock:
                    procedural(member.as<ProceduralBlockSymbol>());
                    break;
                case SymbolKind::Net:
                    symbolNet(member);
                    if (const auto* init = member.as<NetSymbol>().getInitializer()) {
                        const auto id = fresh("init");
                        addNode(id, "expr", "net initializer", "Continuous net initializer: " + expressionText(*init));
                        addPort(id, "rhs", "rhs", "input", init->type->getBitstreamWidth(), 0);
                        addPort(id, "lhs", "lhs", "output", init->type->getBitstreamWidth(), 1);
                        connect(*init, id, "rhs", "sink");
                        endpoint(symbolNet(member), id, "lhs", "driver");
                    }
                    break;
                case SymbolKind::Variable:
                    if (const auto* init = member.as<VariableSymbol>().getInitializer()) {
                        const auto id = fresh("variable-init");
                        addNode(id, "unresolved", "variable initializer",
                                "Variable initialization is not a continuous driver: " + expressionText(*init));
                        addPort(id, "rhs", "rhs", "input", init->type->getBitstreamWidth(), 0);
                        addPort(id, "lhs", "lhs", "unknown", init->type->getBitstreamWidth(), 1);
                        connect(*init, id, "rhs", "sink");
                        endpoint(symbolNet(member), id, "lhs", "unknown");
                    }
                    break;
                case SymbolKind::PrimitiveInstance:
                case SymbolKind::UninstantiatedDef:
                    unsupportedInstance(member);
                    break;
                default: break;
            }
        }
    }

    void procedural(const ProceduralBlockSymbol& block) {
        const auto id = fresh("procedure");
        addNode(id, "unresolved", std::string(toString(block.procedureKind)),
                "Procedural behavior is not synthesized; referenced signals have unknown roles");
        std::unordered_set<const Symbol*> seen;
        size_t ordinal = 0;
        auto visitor = makeVisitor([&](auto&, const ValueExpressionBase& expr) {
            if (!seen.insert(&expr.symbol).second || expr.symbol.kind == SymbolKind::Parameter) return;
            const auto port = "p:" + std::to_string(ordinal);
            addPort(id, port, std::string(expr.symbol.name), "unknown", expr.type->getBitstreamWidth(), ordinal++);
            endpoint(symbolNet(expr.symbol), id, port, "unknown");
        });
        block.getBody().visit(visitor);
    }

    void unsupportedInstance(const Symbol& member) {
        const auto id = fresh("unsupported");
        addNode(id, "unresolved", std::string(member.name), "Unsupported " + std::string(toString(member.kind)));
        size_t ordinal = 0;
        auto connectUnknown = [&](const Expression& expr) {
            const auto port = "p:" + std::to_string(ordinal);
            addPort(id, port, port, "unknown", expr.type->getBitstreamWidth(), ordinal++);
            connect(expr, id, port, "unknown");
        };
        if (member.kind == SymbolKind::PrimitiveInstance) {
            for (const auto* expr : member.as<PrimitiveInstanceSymbol>().getPortConnections()) connectUnknown(*expr);
        }
        else {
            for (const auto* expr : member.as<UninstantiatedDefSymbol>().getPortConnections()) {
                if (expr->kind == AssertionExprKind::Simple) connectUnknown(expr->as<SimpleAssertionExpr>().expr);
            }
        }
    }
};

} // namespace

void writeSchematic(sqlite3* db, slang::ast::Compilation& compilation,
                    const std::set<std::string>& allowedPaths,
                    const std::optional<std::string>& selectedScope) {
    // Scope-keyed tables are WITHOUT ROWID so the primary key and the rows
    // share one b-tree. On a rowid table the autoindex is a second b-tree whose
    // pages interleave with the rows, and a scan that walks the index and then
    // fetches each row ends up jumping across the file.
    const char* schema =
        "CREATE TABLE schematic_metadata(version INTEGER NOT NULL);"
        "INSERT INTO schematic_metadata VALUES(1);"
        "CREATE TABLE schematic_scopes(path TEXT PRIMARY KEY) WITHOUT ROWID;"
        "CREATE TABLE schematic_nodes(scope_path TEXT,id TEXT,kind TEXT,label TEXT,instance_path TEXT,detail TEXT,PRIMARY KEY(scope_path,id)) WITHOUT ROWID;"
        "CREATE TABLE schematic_ports(scope_path TEXT,node_id TEXT,id TEXT,name TEXT,direction TEXT,width INTEGER,ordinal INTEGER,PRIMARY KEY(scope_path,node_id,id)) WITHOUT ROWID;"
        "CREATE TABLE schematic_nets(scope_path TEXT,id TEXT,name TEXT,width INTEGER,status TEXT,PRIMARY KEY(scope_path,id)) WITHOUT ROWID;"
        "CREATE TABLE schematic_endpoints(scope_path TEXT,net_id TEXT,node_id TEXT,port_id TEXT,role TEXT);";
    if (sqlite3_exec(db, schema, nullptr, nullptr, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(db));
    SchematicInserts inserts(db);
    Insert scopeInsert(db, "INSERT INTO schematic_scopes VALUES(?1)");
    bool foundScope = false;
    std::function<void(const Scope&)> visitScope;
    std::function<void(const InstanceSymbol&)> visitInstance = [&](const InstanceSymbol& instance) {
        const auto path = instance.getHierarchicalPath();
        // Keep the full allowed path set so children remain navigable in a single-scope graph.
        if (allowedPaths.contains(path) && (!selectedScope || path == *selectedScope)) {
            foundScope = true;
            scopeInsert.text(1, path);
            scopeInsert.run();
            ScopeGraph(inserts, instance, allowedPaths, compilation.hasIssuedErrors()).collect();
        }
        visitScope(instance.body);
    };
    visitScope = [&](const Scope& scope) {
        for (const auto& member : scope.members()) {
            if (member.kind == SymbolKind::Instance) visitInstance(member.as<InstanceSymbol>());
            else if (member.kind == SymbolKind::GenerateBlock) {
                if (!member.as<GenerateBlockSymbol>().isUninstantiated) visitScope(member.as<Scope>());
            }
            else if (member.kind == SymbolKind::GenerateBlockArray || member.kind == SymbolKind::InstanceArray)
                visitScope(member.as<Scope>());
        }
    };
    for (const auto* instance : compilation.getRoot().topInstances) visitInstance(*instance);
    if (selectedScope && !foundScope) {
        throw std::runtime_error("schematic scope not found in exported hierarchy: " + *selectedScope);
    }
    inserts.finish();
    scopeInsert.finish();
    // Building the index while rows trickle in would interleave its pages with
    // every table's data pages. Creating it once, after all rows are written,
    // keeps the index pages contiguous too. The sort is spilled to a temporary
    // file because holding every endpoint key in memory adds about 2 GiB to the
    // peak resident set.
    if (sqlite3_exec(db, "PRAGMA temp_store=FILE", nullptr, nullptr, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(db));
    if (sqlite3_exec(db, "CREATE INDEX schematic_endpoints_scope ON schematic_endpoints(scope_path)",
                     nullptr, nullptr, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(db));
    if (sqlite3_exec(db, "PRAGMA temp_store=MEMORY", nullptr, nullptr, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(db));
}

} // namespace hier
