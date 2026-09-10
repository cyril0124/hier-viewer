use super::*;
use crate::html::{
    render_core_bin, render_meta_json, render_schematic_js, render_schematic_worker_js,
};
use crate::input::load_input_data;
use crate::model::Config;
use crate::viewer::build_viewer_data;
use crate::{BundleAssets, write_bundle};
use serde_json::{Value, json};

const SCHEMA: &str = "
    CREATE TABLE instances (
        path TEXT PRIMARY KEY, module TEXT NOT NULL DEFAULT 'Module', definition_key INTEGER,
        file_path TEXT DEFAULT '', line INTEGER, column INTEGER, end_line INTEGER, end_column INTEGER,
        definition_file_path TEXT DEFAULT '', definition_line INTEGER, definition_column INTEGER,
        definition_end_line INTEGER, definition_end_column INTEGER,
        module_port_count INTEGER DEFAULT 0, module_logic_count INTEGER DEFAULT 0,
        module_reg_count INTEGER DEFAULT 0, module_wire_count INTEGER DEFAULT 0,
        module_variable_count INTEGER DEFAULT 0, module_net_count INTEGER DEFAULT 0,
        module_signal_count INTEGER DEFAULT 0, module_variable_bits INTEGER DEFAULT 0,
        module_net_bits INTEGER DEFAULT 0, module_signal_bits INTEGER DEFAULT 0,
        module_internal_signal_count INTEGER DEFAULT 0, module_gen_signal_count INTEGER DEFAULT 0
    );
    CREATE TABLE schematic_metadata(version INTEGER NOT NULL);
    INSERT INTO schematic_metadata VALUES(1);
    CREATE TABLE schematic_scopes(path TEXT PRIMARY KEY);
    CREATE TABLE schematic_nodes(scope_path TEXT,id TEXT,kind TEXT,label TEXT,instance_path TEXT,detail TEXT, PRIMARY KEY(scope_path,id));
    CREATE TABLE schematic_ports(scope_path TEXT,node_id TEXT,id TEXT,name TEXT,direction TEXT,width INTEGER,ordinal INTEGER, PRIMARY KEY(scope_path,node_id,id));
    CREATE TABLE schematic_nets(scope_path TEXT,id TEXT,name TEXT,width INTEGER,status TEXT, PRIMARY KEY(scope_path,id));
    CREATE TABLE schematic_endpoints(scope_path TEXT,net_id TEXT,node_id TEXT,port_id TEXT,role TEXT);
";

const CONNECTED_SCOPE: &str = "
    INSERT INTO instances(path) VALUES('top'), ('top.u');
    INSERT INTO schematic_scopes VALUES('top'), ('top.u');
    INSERT INTO schematic_nodes VALUES('top','boundary','boundary','input',NULL,'scope input');
    INSERT INTO schematic_nodes VALUES('top','child','module','u','top.u','Child module');
    INSERT INTO schematic_ports VALUES('top','boundary','p','input','input',8,0);
    INSERT INTO schematic_ports VALUES('top','child','p','data','input',8,0);
    INSERT INTO schematic_nets VALUES('top','bus','data',8,'resolved');
    INSERT INTO schematic_endpoints VALUES('top','bus','boundary','p','driver');
    INSERT INTO schematic_endpoints VALUES('top','bus','child','p','sink');
";

fn empty_database() -> Connection {
    let connection = Connection::open_in_memory().expect("open test DB");
    connection.execute_batch(SCHEMA).expect("create schema");
    connection
}

fn connected_database() -> Connection {
    let connection = empty_database();
    connection
        .execute_batch(CONNECTED_SCOPE)
        .expect("insert graph");
    connection
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).expect("read JSON")).expect("parse JSON")
}

fn config() -> Config {
    Config {
        db_path: None,
        output_path: None,
        title: None,
        no_wizard: true,
        rebuild_sqlite: false,
        schematic: true,
        preview: false,
        preview_host: String::new(),
        preview_port: 0,
        rtl_inputs: Vec::new(),
        filelists: Vec::new(),
        extra_args_tokens: Vec::new(),
        debug: false,
        coverage: None,
    }
}

#[test]
fn cached_scope_json_is_reused_and_rebuilt_after_corruption() {
    let directory = tempfile::tempdir().expect("cache directory");
    let path = directory.path().join("hierarchy.sqlite");
    let connection = Connection::open(&path).expect("open file DB");
    connection
        .execute_batch(&format!("{SCHEMA}{CONNECTED_SCOPE}"))
        .expect("create connected DB");

    let first = load_schematic_cached(&connection, &path)
        .expect("build schematic cache")
        .expect("schematic data");
    let first_directory = first.directory.path().to_owned();
    assert!(first_directory.join("manifest.json").is_file());
    drop(first);

    let second = load_schematic_cached(&connection, &path)
        .expect("reuse schematic cache")
        .expect("cached schematic data");
    assert_eq!(second.directory.path(), first_directory);
    fs::remove_file(first_directory.join("0.json")).expect("corrupt cached scope");
    drop(second);

    let rebuilt = load_schematic_cached(&connection, &path)
        .expect("rebuild corrupt schematic cache")
        .expect("rebuilt schematic data");
    assert_ne!(rebuilt.directory.path(), first_directory);
}
#[test]
fn missing_tables_and_valid_empty_graphs_are_distinct() {
    let legacy = Connection::open_in_memory().expect("open legacy DB");
    assert!(load_schematic(&legacy).expect("legacy DB").is_none());
    let connection = empty_database();
    let schematic = load_schematic(&connection)
        .expect("empty schema")
        .expect("available schema");
    assert!(schematic.scopes.is_empty());

    connection.execute_batch("INSERT INTO instances(path) VALUES('empty'); INSERT INTO schematic_scopes VALUES('empty');").expect("insert empty scope");
    let schematic = load_schematic(&connection)
        .expect("load empty scope")
        .expect("available scope");
    let graph = read_json(schematic.directory.path().join("0.json"));
    assert_eq!(
        graph,
        json!({"version":1,"scopePath":"empty","nodes":[],"nets":[]})
    );
}

#[test]
fn legacy_input_still_builds_core_with_null_schematic_metadata() {
    let directory = tempfile::tempdir().expect("input directory");
    let path = directory.path().join("legacy.sqlite");
    let connection = Connection::open(&path).expect("open DB");
    connection.execute_batch(SCHEMA).expect("create schema");
    for table in TABLES {
        connection
            .execute_batch(&format!("DROP TABLE {table}"))
            .expect("remove schematic table");
    }
    connection
        .execute_batch("INSERT INTO instances(path) VALUES('legacy')")
        .expect("insert legacy instance");
    drop(connection);
    let input = load_input_data(path.to_str().expect("UTF-8 path"), true).expect("load legacy DB");
    assert!(input.schematic.is_none());
    let data = build_viewer_data(input, &config()).expect("build legacy viewer");
    assert_eq!(data.nodes[data.root_id].name, "legacy");
    assert!(
        render_core_bin(&data)
            .expect("core binary")
            .starts_with(b"HVC1")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&render_meta_json(&data)).expect("metadata")["schematic"],
        Value::Null
    );
}

#[test]
fn partial_schema_is_corruption_even_when_tables_are_empty() {
    for table in TABLES {
        let connection = empty_database();
        connection
            .execute_batch(&format!("DROP TABLE {table}"))
            .expect("remove table");
        let error = load_schematic(&connection).expect_err("partial schema must fail");
        assert!(
            error.contains("CORRUPTION") && error.contains(table),
            "{error}"
        );
    }
    let connection = empty_database();
    connection
        .execute_batch("ALTER TABLE schematic_ports RENAME COLUMN width TO missing_width")
        .expect("remove column");
    let error = load_schematic(&connection).expect_err("missing column must fail");
    assert!(
        error.contains("CORRUPTION") && error.contains("width"),
        "{error}"
    );
}

#[test]
fn unsupported_or_ambiguous_metadata_is_corruption() {
    for mutation in [
        "DELETE FROM schematic_metadata",
        "INSERT INTO schematic_metadata VALUES(1)",
        "UPDATE schematic_metadata SET version = 2",
        "UPDATE schematic_metadata SET version = 0",
        "UPDATE schematic_metadata SET version = 'unknown'",
        "UPDATE schematic_metadata SET version = 1.5",
    ] {
        let connection = empty_database();
        connection.execute_batch(mutation).expect("mutate version");
        let error = load_schematic(&connection).expect_err("invalid metadata must fail");
        assert!(
            error.contains("CORRUPTION") && error.contains("version 1"),
            "{mutation}: {error}"
        );
    }
}

#[test]
fn invalid_values_and_dangling_references_are_corruption() {
    for mutation in [
        "UPDATE schematic_nodes SET kind = 'gate'",
        "UPDATE schematic_nodes SET label = NULL",
        "UPDATE schematic_nodes SET detail = NULL",
        "UPDATE schematic_nodes SET instance_path = 'top.missing' WHERE id = 'child'",
        "UPDATE schematic_ports SET direction = 'invalid'",
        "UPDATE schematic_ports SET width = -1",
        "UPDATE schematic_ports SET width = 1.5",
        "UPDATE schematic_ports SET width = 'wide'",
        "UPDATE schematic_ports SET width = NULL",
        "UPDATE schematic_ports SET width = 9007199254740992",
        "UPDATE schematic_ports SET ordinal = -1",
        "UPDATE schematic_ports SET ordinal = NULL",
        "UPDATE schematic_nets SET width = -1",
        "UPDATE schematic_nets SET width = 1.5",
        "UPDATE schematic_nets SET width = NULL",
        "UPDATE schematic_nets SET status = 'invalid'",
        "UPDATE schematic_endpoints SET role = 'invalid'",
        "UPDATE schematic_endpoints SET role = NULL",
        "UPDATE schematic_nodes SET scope_path = 'missing'",
        "UPDATE schematic_ports SET scope_path = 'missing'",
        "UPDATE schematic_nets SET scope_path = 'missing'",
        "UPDATE schematic_endpoints SET scope_path = 'missing'",
        "UPDATE schematic_endpoints SET scope_path = NULL",
        "UPDATE schematic_ports SET node_id = 'missing' WHERE node_id = 'boundary'",
        "DELETE FROM schematic_ports WHERE node_id = 'boundary'",
        "UPDATE schematic_endpoints SET node_id = 'missing'",
        "UPDATE schematic_endpoints SET port_id = 'missing'",
        "UPDATE schematic_endpoints SET net_id = 'missing'",
        "INSERT INTO schematic_endpoints SELECT * FROM schematic_endpoints LIMIT 1",
        "DELETE FROM schematic_scopes WHERE path = 'top.u'",
    ] {
        let connection = connected_database();
        connection.execute_batch(mutation).expect("mutate graph");
        let error = load_schematic(&connection).expect_err("invalid graph must fail");
        assert!(error.contains("CORRUPTION"), "{mutation}: {error}");
    }
}

#[test]
fn orphan_rows_before_between_after_or_without_scopes_are_corruption() {
    for (table, columns) in [
        ("schematic_nodes", "id, kind, label, instance_path, detail"),
        (
            "schematic_ports",
            "node_id, id, name, direction, width, ordinal",
        ),
        ("schematic_nets", "id, name, width, status"),
        ("schematic_endpoints", "net_id, node_id, port_id, role"),
    ] {
        for path in ["aaa", "top.t", "zzz"] {
            let connection = connected_database();
            connection
                .execute(
                    &format!("INSERT INTO {table} SELECT ?1, {columns} FROM {table} LIMIT 1"),
                    [path],
                )
                .expect("add rows in unknown scope");
            let error = load_schematic(&connection).expect_err("orphan rows must fail");
            assert!(
                error.contains("CORRUPTION") && error.contains("unknown scope"),
                "{table} {path}: {error}"
            );
        }
        let connection = connected_database();
        for other in [
            "schematic_nodes",
            "schematic_ports",
            "schematic_nets",
            "schematic_endpoints",
        ] {
            if other != table {
                connection
                    .execute(&format!("DELETE FROM {other}"), [])
                    .expect("remove other graph rows");
            }
        }
        connection
            .execute_batch("DELETE FROM schematic_scopes; DELETE FROM instances;")
            .expect("remove scopes and hierarchy");
        let error = load_schematic(&connection).expect_err("unconsumed rows must fail");
        assert!(error.contains("CORRUPTION"), "{table}: {error}");
    }
}

#[test]
fn streaming_reads_reject_invalid_scalars() {
    for mutation in [
        "UPDATE schematic_scopes SET path = '' WHERE path = 'top.u'",
        "UPDATE schematic_scopes SET path = NULL WHERE path = 'top.u'",
        "UPDATE schematic_scopes SET path = x'6162' WHERE path = 'top.u'",
        "UPDATE schematic_nodes SET id = '' WHERE id = 'child'",
        "UPDATE schematic_nodes SET label = x'6162'",
        "UPDATE schematic_nodes SET instance_path = '' WHERE id = 'child'",
        "UPDATE schematic_nodes SET instance_path = x'6162' WHERE id = 'child'",
        "UPDATE schematic_ports SET id = ''",
        "UPDATE schematic_ports SET name = x'6162'",
        "UPDATE schematic_ports SET ordinal = 1.5",
        "UPDATE schematic_ports SET ordinal = 9007199254740992",
        "UPDATE schematic_nets SET id = ''",
        "UPDATE schematic_nets SET width = 9007199254740992",
        "UPDATE schematic_nets SET name = x'6162'",
        "UPDATE schematic_endpoints SET scope_path = x'6162'",
        "UPDATE schematic_endpoints SET net_id = x'6162'",
        "UPDATE schematic_endpoints SET node_id = NULL",
        "UPDATE schematic_endpoints SET port_id = x'6162'",
    ] {
        let connection = connected_database();
        connection.execute_batch(mutation).expect("mutate scalar");
        let error = load_schematic(&connection).expect_err("invalid scalar must fail");
        assert!(error.contains("CORRUPTION"), "{mutation}: {error}");
    }
}

#[test]
fn local_sort_preserves_port_and_endpoint_order_with_or_without_index() {
    for indexed in [false, true] {
        let connection = connected_database();
        if indexed {
            connection
                .execute_batch(
                    "CREATE INDEX schematic_endpoints_scope ON schematic_endpoints(scope_path)",
                )
                .expect("create exporter index");
        }
        connection
            .execute_batch(
                "
            INSERT INTO schematic_ports VALUES('top','child','z','z','input',1,0);
            INSERT INTO schematic_ports VALUES('top','child','a','a','input',1,1);
            DELETE FROM schematic_endpoints;
            INSERT INTO schematic_endpoints VALUES('top','bus','child','p','sink');
            INSERT INTO schematic_endpoints VALUES('top','bus','child','z','sink');
            INSERT INTO schematic_endpoints VALUES('top','bus','boundary','p','driver');
            INSERT INTO schematic_endpoints VALUES('top','bus','child','p','driver');
        ",
            )
            .expect("insert unordered graph");
        let input = load_schematic(&connection)
            .expect("load")
            .expect("available");
        let graph = read_json(input.directory.path().join("0.json"));
        let ports: Vec<_> = graph["nodes"][1]["ports"]
            .as_array()
            .expect("ports")
            .iter()
            .map(|port| port["id"].as_str().expect("id"))
            .collect();
        assert_eq!(ports, ["p", "z", "a"]);
        assert_eq!(
            graph["nets"][0]["endpoints"],
            json!([
                {"nodeId":"boundary","portId":"p","role":"driver"},
                {"nodeId":"child","portId":"p","role":"driver"},
                {"nodeId":"child","portId":"p","role":"sink"},
                {"nodeId":"child","portId":"z","role":"sink"}
            ])
        );
        connection
            .execute_batch("INSERT INTO schematic_endpoints VALUES('top','bus','child','p','sink')")
            .expect("insert nonadjacent duplicate");
        let error = load_schematic(&connection).expect_err("duplicate must fail after sorting");
        assert!(error.contains("duplicate endpoint"), "{error}");
    }
}

#[test]
fn graph_json_preserves_contract_and_unknown_widths() {
    let connection = connected_database();
    connection.execute_batch("UPDATE schematic_ports SET width=0, direction='unknown' WHERE node_id='child'; UPDATE schematic_nets SET width=0, status='unresolved';").expect("unknown width");
    let schematic = load_schematic(&connection)
        .expect("load")
        .expect("available");
    let graph = read_json(schematic.directory.path().join("0.json"));
    assert_eq!(
        graph,
        json!({
            "version":1,"scopePath":"top",
            "nodes":[
                {"id":"boundary","kind":"boundary","label":"input","instancePath":null,"detail":"scope input","ports":[{"id":"p","name":"input","direction":"input","width":8,"ordinal":0}]},
                {"id":"child","kind":"module","label":"u","instancePath":"top.u","detail":"Child module","ports":[{"id":"p","name":"data","direction":"unknown","width":0,"ordinal":0}]}
            ],
            "nets":[{"id":"bus","name":"data","width":0,"status":"unresolved","endpoints":[{"nodeId":"boundary","portId":"p","role":"driver"},{"nodeId":"child","portId":"p","role":"sink"}]}]
        })
    );
}

#[test]
fn scope_mapping_uses_instance_paths_and_survives_input_removal() {
    let input_dir = tempfile::tempdir().expect("input directory");
    let db_path = input_dir.path().join("input.sqlite");
    let connection = Connection::open(&db_path).expect("open DB");
    connection.execute_batch(SCHEMA).expect("create schema");
    connection.execute_batch("
        INSERT INTO instances(path,definition_key) VALUES('top',1),('top.gen[0].u',2),('top.gen[1].u',2),('other',1);
        INSERT INTO schematic_scopes SELECT path FROM instances;
        INSERT INTO schematic_nodes VALUES('top.gen[0].u','same','boundary','a',NULL,'first instance'),('top.gen[1].u','same','boundary','b',NULL,'second instance');
        INSERT INTO schematic_ports VALUES('top.gen[0].u','same','p','a','input',8,0),('top.gen[1].u','same','p','b','output',32,0);
        INSERT INTO schematic_nets VALUES('top.gen[0].u','bus','a',8,'resolved'),('top.gen[1].u','bus','b',32,'unresolved');
        INSERT INTO schematic_endpoints VALUES('top.gen[0].u','bus','same','p','driver'),('top.gen[1].u','bus','same','p','sink');
    ").expect("insert instance graphs");
    drop(connection);
    let input = load_input_data(db_path.to_str().expect("UTF-8 path"), true).expect("load input");
    fs::remove_file(&db_path).expect("remove original DB before bundle writing");
    let mut data = build_viewer_data(input, &config()).expect("build viewer");
    assert_eq!(data.root_id, 0);
    let schematic = data.schematic.as_ref().expect("schematic data");
    let first = schematic
        .paths
        .iter()
        .position(|path| path == "top.gen[0].u")
        .expect("first node");
    let second = schematic
        .paths
        .iter()
        .position(|path| path == "top.gen[1].u")
        .expect("second node");
    let generated = schematic
        .paths
        .iter()
        .position(|path| path == "top.gen[0]")
        .expect("generate node");
    assert_eq!(
        data.nodes[first].definition_key,
        data.nodes[second].definition_key
    );

    let output_dir = tempfile::tempdir().expect("output directory");
    let meta = render_meta_json(&data);
    let core = render_core_bin(&data).expect("render core");
    let assets = BundleAssets {
        index_html: "test index",
        meta_json: &meta,
        core_bin: &core,
        analysis_bin: None,
        chart_js: "test chart",
        coverage_js: "test coverage",
        schematic_js: render_schematic_js(),
        schematic_worker_js: render_schematic_worker_js(),
        schematic: Some(schematic),
        nodes: &data.nodes,
        three_js: "test three",
        three_core_js: "test three core",
    };
    write_bundle(output_dir.path().to_str().expect("UTF-8 output"), &assets).expect("write bundle");
    let graph = |id| read_json(output_dir.path().join(format!("schematic/{id}.json")));
    assert_eq!(graph(first)["scopePath"], "top.gen[0].u");
    assert_eq!(graph(first)["nodes"][0]["detail"], "first instance");
    assert_eq!(graph(first)["nets"][0]["width"], 8);
    assert_eq!(graph(second)["scopePath"], "top.gen[1].u");
    assert_eq!(graph(second)["nodes"][0]["detail"], "second instance");
    assert_eq!(graph(second)["nets"][0]["width"], 32);
    assert_eq!(graph(generated)["nodes"][0]["instancePath"], "top.gen[0].u");
    assert_eq!(graph(generated)["nets"], json!([]));
    assert_eq!(graph(0)["scopePath"], "");
    assert_eq!(graph(0)["nodes"].as_array().expect("forest nodes").len(), 2);
    assert_eq!(graph(0)["nets"], json!([]));
    for id in 0..data.nodes.len() {
        assert!(
            output_dir
                .path()
                .join(format!("schematic/{id}.json"))
                .is_file()
        );
    }
    assert_eq!(
        read_json(output_dir.path().join("viewer-meta.json"))["schematic"],
        json!({"version":1,"directory":"schematic"})
    );
    assert_eq!(
        fs::read_to_string(output_dir.path().join("viewer-schematic.js")).expect("script"),
        render_schematic_js()
    );
    assert_eq!(
        fs::read_to_string(output_dir.path().join("viewer-schematic-worker.js")).expect("worker"),
        render_schematic_worker_js()
    );
    data.schematic = None;
    assert_eq!(render_core_bin(&data).expect("legacy core"), core);
    assert_eq!(
        serde_json::from_str::<Value>(&render_meta_json(&data)).expect("legacy metadata")["schematic"],
        Value::Null
    );
}

#[test]
fn unknown_scope_path_is_corruption_during_hierarchy_mapping() {
    let connection = empty_database();
    connection
        .execute_batch("INSERT INTO schematic_scopes VALUES('missing')")
        .expect("unknown scope");
    let input = load_schematic(&connection)
        .expect("load graph")
        .expect("available");
    let error = input
        .bind(&HashMap::new(), 1)
        .expect_err("unknown scope must fail");
    assert!(
        error.contains("CORRUPTION") && error.contains("missing"),
        "{error}"
    );
}
