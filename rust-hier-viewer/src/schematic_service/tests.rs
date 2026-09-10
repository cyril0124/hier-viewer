use super::*;

fn fixture() -> (tempfile::TempDir, Arc<SchematicService>) {
    let root = tempfile::tempdir().expect("fixture directory");
    let database = root.path().join("hierarchy.sqlite");
    fs::write(&database, "unchanged source snapshot").expect("write source marker");
    let recipe = Recipe {
        version: 1,
        database_stamp: database_stamp(&database).expect("source stamp"),
        database,
        rtl: None,
        scopes: vec![
            Scope {
                path: String::new(),
                name: "root".into(),
                module: String::new(),
                children: vec![1],
                electrical: false,
            },
            Scope {
                path: "top".into(),
                name: "top".into(),
                module: "Top".into(),
                children: Vec::new(),
                electrical: false,
            },
        ],
    };
    let path = root.path().join(RECIPE_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    serde_json::to_writer(fs::File::create(path).unwrap(), &recipe).unwrap();
    let service = SchematicService::new(root.path()).unwrap();
    (root, service)
}

fn finish(service: &SchematicService) {
    let handle = service.worker.lock().unwrap().take().expect("build worker");
    handle.join().expect("completed worker");
}

#[test]
fn only_requested_scope_is_built_and_cache_survives_restart() {
    let (root, service) = fixture();
    assert!(!service.directory.exists());
    assert_eq!(service.request(0).unwrap().0, 202);
    finish(&service);
    let file = service.scope_file(0).unwrap();
    let graph: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(graph["nodes"][0]["instancePath"], "top");
    assert_eq!(graph["nets"], serde_json::json!([]));
    assert!(!service.directory.join("1.json").exists());
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    assert_eq!(service.request(0).unwrap().0, 200);
    assert!(service.worker.lock().unwrap().is_none());
    service.shutdown();
    let restarted = SchematicService::new(root.path()).unwrap();
    assert_eq!(restarted.request(0).unwrap().0, 200);
    assert_eq!(
        fs::metadata(restarted.scope_file(0).unwrap())
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert!(restarted.worker.lock().unwrap().is_none());
}

#[test]
fn changed_source_never_serves_cached_scope() {
    let (_root, service) = fixture();
    service.request(0).unwrap();
    finish(&service);
    fs::write(&service.recipe.as_ref().unwrap().database, "changed").unwrap();
    assert_eq!(service.request(0).err().unwrap().status, 409);
    assert_eq!(service.scope_file(0).err().unwrap().status, 409);
}

#[test]
fn unavailable_unknown_and_incomplete_scopes_do_not_start_builds() {
    let root = tempfile::tempdir().unwrap();
    let unavailable = SchematicService::new(root.path()).unwrap();
    assert_eq!(unavailable.request(0).err().unwrap().status, 404);
    let (_root, service) = fixture();
    assert_eq!(service.request(2).err().unwrap().status, 404);
    assert_eq!(service.scope_file(0).err().unwrap().status, 404);
    assert!(service.worker.lock().unwrap().is_none());
}

#[test]
fn concurrent_requests_share_build_and_do_not_queue_unbounded_work() {
    let (_root, service) = fixture();
    service.state.lock().unwrap().active = Some(0);
    assert_eq!(service.request(0).unwrap().1.state, "building");
    assert_eq!(service.request(1).unwrap().1.state, "busy");
    assert!(service.worker.lock().unwrap().is_none());
}

#[test]
fn failure_is_reported_and_explicit_retry_can_build_again() {
    let (_root, service) = fixture();
    service.state.lock().unwrap().failure = Some((0, "exporter failed".into()));
    let error = service.request(0).err().unwrap();
    assert_eq!(error.status, 422);
    assert_eq!(error.message, "exporter failed");
    assert_eq!(service.request(0).unwrap().0, 202);
    finish(&service);
    assert_eq!(service.request(0).unwrap().0, 200);
    service.shutdown();
    assert_eq!(service.request(1).err().unwrap().status, 503);
}
