use super::*;
use serde_json::json;

fn database() -> Connection {
    let connection = Connection::open_in_memory().expect("open scope test DB");
    connection
        .execute_batch(
            "CREATE TABLE instances(path TEXT PRIMARY KEY);
             CREATE TABLE schematic_metadata(version INTEGER NOT NULL);
             INSERT INTO schematic_metadata VALUES(1);
             CREATE TABLE schematic_scopes(path TEXT PRIMARY KEY);
             CREATE TABLE schematic_nodes(
                 scope_path TEXT, id TEXT, kind TEXT, label TEXT, instance_path TEXT,
                 detail TEXT, PRIMARY KEY(scope_path, id));
             CREATE TABLE schematic_ports(
                 scope_path TEXT, node_id TEXT, id TEXT, name TEXT, direction TEXT,
                 width INTEGER, ordinal INTEGER, PRIMARY KEY(scope_path, node_id, id));
             CREATE TABLE schematic_nets(
                 scope_path TEXT, id TEXT, name TEXT, width INTEGER, status TEXT,
                 PRIMARY KEY(scope_path, id));
             CREATE TABLE schematic_endpoints(
                 scope_path TEXT, net_id TEXT, node_id TEXT, port_id TEXT, role TEXT);
             CREATE INDEX endpoint_scope ON schematic_endpoints(scope_path);
             INSERT INTO instances VALUES('top'), ('top.child');
             INSERT INTO schematic_scopes VALUES('top'), ('top.child');
             INSERT INTO schematic_nodes VALUES
                 ('top', 'z', 'module', 'child', 'top.child', 'Child'),
                 ('top', 'a', 'boundary', 'input', NULL, 'Input');
             INSERT INTO schematic_ports VALUES
                 ('top', 'z', 'late', 'late', 'input', 8, 2),
                 ('top', 'z', 'b', 'b', 'input', 8, 1),
                 ('top', 'z', 'a', 'a', 'input', 8, 1),
                 ('top', 'a', 'p', 'input', 'input', 8, 0);
             INSERT INTO schematic_nets VALUES
                 ('top', 'z', 'unused', 8, 'unresolved'),
                 ('top', 'a', 'data', 8, 'resolved');
             INSERT INTO schematic_endpoints VALUES
                 ('top', 'a', 'z', 'a', 'sink'),
                 ('top', 'a', 'a', 'p', 'driver');",
        )
        .expect("create scope fixture");
    connection
}

#[test]
fn selected_scope_matches_full_export_bytes_and_order() {
    let connection = database();
    let full = load_schematic(&connection)
        .expect("load full graph")
        .expect("schematic available");
    let directory = tempfile::tempdir().expect("output directory");
    let destination = directory.path().join("scope.json");
    for scope in ["top", "top.child"] {
        write_scope_from_db(&connection, scope, &destination).expect("write selected scope");
        let index = full.scopes[scope];
        let expected =
            fs::read(full.directory.path().join(format!("{index}.json"))).expect("read full scope");
        assert_eq!(
            fs::read(&destination).expect("read selected scope"),
            expected
        );
    }
}

#[test]
fn selected_scope_ignores_unrelated_corrupt_graph_rows() {
    let connection = database();
    let directory = tempfile::tempdir().expect("output directory");
    let destination = directory.path().join("scope.json");
    write_scope_from_db(&connection, "top", &destination).expect("baseline scope");
    let expected = fs::read(&destination).expect("read baseline");

    // Exercise every filtered table before and after the requested scope, as
    // well as its child. Invalid typed values must never reach row parsing.
    for scope in ["aaa", "top.child", "zzz"] {
        connection
            .execute(
                "INSERT INTO schematic_nodes VALUES(?1, 'bad', NULL, NULL, NULL, NULL)",
                [scope],
            )
            .expect("insert corrupt node");
        connection
            .execute(
                "INSERT INTO schematic_ports VALUES(?1, 'bad', 'p', '', '', 'wide', -1)",
                [scope],
            )
            .expect("insert corrupt port");
        connection
            .execute(
                "INSERT INTO schematic_nets VALUES(?1, 'bad', '', 'wide', '')",
                [scope],
            )
            .expect("insert corrupt net");
        connection
            .execute(
                "INSERT INTO schematic_endpoints VALUES(?1, NULL, NULL, NULL, NULL)",
                [scope],
            )
            .expect("insert corrupt endpoint");
    }
    connection
        .execute_batch(
            "INSERT INTO schematic_scopes VALUES(NULL), ('');
             INSERT INTO instances VALUES('missing_scope');",
        )
        .expect("insert unrelated invalid scopes");

    write_scope_from_db(&connection, "top", &destination).expect("write valid selected scope");
    assert_eq!(
        fs::read(&destination).expect("read selected scope"),
        expected
    );
    assert!(load_schematic(&connection).is_err());
}

#[test]
fn selected_scope_reports_missing_schema_and_scope() {
    let directory = tempfile::tempdir().expect("output directory");
    let destination = directory.path().join("scope.json");
    let legacy = Connection::open_in_memory().expect("open legacy DB");
    let error = write_scope_from_db(&legacy, "top", &destination).expect_err("missing schema");
    assert!(error.contains("missing schematic schema"), "{error}");

    let connection = database();
    // Orphan rows must not obscure the explicit missing-scope error.
    connection
        .execute("DELETE FROM schematic_scopes WHERE path = 'top'", [])
        .expect("remove scope");
    let error = write_scope_from_db(&connection, "top", &destination).expect_err("missing scope");
    assert!(error.contains("scope 'top' is missing"), "{error}");
    assert!(!destination.exists());
}

#[test]
fn selected_empty_scope_supports_literal_paths() {
    let connection = database();
    let scope = "empty' OR 1=1 --";
    connection
        .execute("INSERT INTO instances VALUES(?1)", [scope])
        .expect("insert empty instance");
    connection
        .execute("INSERT INTO schematic_scopes VALUES(?1)", [scope])
        .expect("insert empty scope");
    let directory = tempfile::tempdir().expect("output directory");
    let destination = directory.path().join("empty.json");
    write_scope_from_db(&connection, scope, &destination).expect("write empty scope");
    let actual: serde_json::Value =
        serde_json::from_slice(&fs::read(destination).expect("read empty scope"))
            .expect("parse empty scope");
    assert_eq!(
        actual,
        json!({"version": 1, "scopePath": scope, "nodes": [], "nets": []})
    );
}

#[test]
fn selected_scope_retains_schema_metadata_and_graph_validation() {
    for mutation in [
        "DROP TABLE schematic_ports",
        "ALTER TABLE schematic_ports RENAME COLUMN width TO missing_width",
        "UPDATE schematic_metadata SET version = 2",
        "UPDATE schematic_nodes SET kind = 'invalid'",
        "UPDATE schematic_nodes SET instance_path = 'absent' WHERE id = 'z'",
        "UPDATE schematic_ports SET width = -1",
        "UPDATE schematic_ports SET node_id = 'absent'",
        "UPDATE schematic_nets SET status = 'invalid'",
        "UPDATE schematic_endpoints SET port_id = 'absent'",
        "INSERT INTO schematic_endpoints SELECT * FROM schematic_endpoints LIMIT 1",
        "DELETE FROM instances WHERE path = 'top'",
    ] {
        let connection = database();
        connection.execute_batch(mutation).expect("corrupt fixture");
        let directory = tempfile::tempdir().expect("output directory");
        let destination = directory.path().join("scope.json");
        let error = write_scope_from_db(&connection, "top", &destination)
            .expect_err("selected corruption must fail");
        assert!(error.contains("CORRUPTION"), "{mutation}: {error}");
        assert!(!destination.exists());
    }
}
