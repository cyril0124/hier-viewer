use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{SchematicDirectory, SchematicInput, load_schematic, load_schematic_in};

// Bump when validation or the serialized graph contract changes.
const CACHE_VERSION: u32 = 1;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct FileStamp {
    length: u64,
    modified_seconds: u64,
    modified_nanoseconds: u32,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(FileStamp {
        length: metadata.len(),
        modified_seconds: modified.as_secs(),
        modified_nanoseconds: modified.subsec_nanos(),
        #[cfg(unix)]
        changed_seconds: metadata.ctime(),
        #[cfg(unix)]
        changed_nanoseconds: metadata.ctime_nsec(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}

#[derive(Deserialize, Serialize)]
struct CachedScope {
    path: String,
    file: FileStamp,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: u32,
    database: FileStamp,
    scopes: Vec<CachedScope>,
}

fn read_cache(directory: &Path, database: &FileStamp) -> Option<SchematicInput> {
    if !fs::symlink_metadata(directory).ok()?.is_dir() {
        return None;
    }
    let manifest_path = directory.join("manifest.json");
    file_stamp(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    if manifest.version != CACHE_VERSION || manifest.database != *database {
        return None;
    }
    let mut scopes = HashMap::with_capacity(manifest.scopes.len());
    for (index, scope) in manifest.scopes.into_iter().enumerate() {
        if scope.path.is_empty()
            || scopes.insert(scope.path, index).is_some()
            || file_stamp(&directory.join(format!("{index}.json")))? != scope.file
        {
            return None;
        }
    }
    Some(SchematicInput {
        directory: SchematicDirectory::Persistent(directory.to_path_buf()),
        scopes,
    })
}

fn persist(input: SchematicInput, database: FileStamp) -> SchematicInput {
    let mut paths = vec![String::new(); input.scopes.len()];
    for (path, &index) in &input.scopes {
        paths[index].clone_from(path);
    }
    let scopes = paths
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            Some(CachedScope {
                path,
                file: file_stamp(&input.directory.path().join(format!("{index}.json")))?,
            })
        })
        .collect::<Option<Vec<_>>>();
    let Some(scopes) = scopes else { return input };
    let manifest = Manifest {
        version: CACHE_VERSION,
        database,
        scopes,
    };
    let Ok(bytes) = serde_json::to_vec(&manifest) else {
        return input;
    };
    if fs::write(input.directory.path().join("manifest.json"), bytes).is_err() {
        return input;
    }
    let SchematicInput { directory, scopes } = input;
    let directory = match directory {
        SchematicDirectory::Temporary(temporary) => {
            SchematicDirectory::Persistent(temporary.keep())
        }
        directory => directory,
    };
    SchematicInput { directory, scopes }
}

/// Reuse validated JSON beside an immutable SQLite export. Cache generations
/// remain independent of output bundles; failed writes fall back to staging.
pub(crate) fn load_schematic_cached(
    connection: &Connection,
    path: &Path,
) -> Result<Option<SchematicInput>, String> {
    let Ok(database_path) = path.canonicalize() else {
        return load_schematic(connection);
    };
    let Some(database) = file_stamp(&database_path) else {
        return load_schematic(connection);
    };
    // WAL changes need not update the main database's metadata. Avoid treating
    // that file alone as a complete cache identity for live WAL databases.
    let journal: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(super::corrupt)?;
    if journal.eq_ignore_ascii_case("wal") {
        return load_schematic(connection);
    }
    let Some(parent) = database_path.parent() else {
        return load_schematic(connection);
    };
    let Some(name) = database_path.file_name().and_then(|name| name.to_str()) else {
        return load_schematic(connection);
    };
    let prefix = format!("{name}.schematic-");
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(&prefix) {
                continue;
            }
            let Some(input) = read_cache(&entry.path(), &database) else {
                continue;
            };
            super::validate_schema(connection)?;
            super::validate_metadata(connection)?;
            let mut statement = connection
                .prepare("SELECT path FROM schematic_scopes")
                .map_err(super::corrupt)?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(super::corrupt)?;
            let mut count = 0;
            let mut matches = true;
            for path in paths {
                matches &= input.scopes.contains_key(&path.map_err(super::corrupt)?);
                count += 1;
            }
            if matches
                && count == input.scopes.len()
                && file_stamp(&database_path).as_ref() == Some(&database)
            {
                crate::logging::info("schematic", "Reusing cached scope JSON files.");
                return Ok(Some(input));
            }
        }
    }
    let staging = tempfile::Builder::new()
        .prefix(&prefix)
        .tempdir_in(parent)
        .ok();
    let can_persist = staging.is_some();
    let Some(input) = load_schematic_in(connection, staging)? else {
        return Ok(None);
    };
    if file_stamp(&database_path).as_ref() != Some(&database) {
        return Err("schematic database changed while generating scope JSON".to_string());
    }
    Ok(Some(if can_persist {
        persist(input, database)
    } else {
        input
    }))
}
