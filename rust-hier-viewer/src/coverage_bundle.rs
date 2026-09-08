use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tempfile::TempDir;

use crate::coverage_import::report_files;
use crate::model::CoverageConfig;

pub(crate) struct BundledCoverage {
    directory: TempDir,
    manifest_url: String,
}

#[derive(Serialize)]
struct Manifest<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
    files: &'a [String],
}

impl BundledCoverage {
    // A fresh directory avoids overwriting user files and older deployed reports.
    // Until persist(), errors automatically remove only this run's copied report.
    pub(crate) fn prepare(config: &CoverageConfig, output: &Path) -> Result<Self, String> {
        let report_root = fs::canonicalize(&config.report_path).map_err(|err| {
            format!(
                "cannot open coverage report '{}': {err}",
                config.report_path
            )
        })?;
        let mut files = report_files(&report_root).map_err(|err| err.message)?;
        files.retain(|file| {
            matches!(
                Path::new(file).extension().and_then(|ext| ext.to_str()),
                Some("xml" | "html")
            )
        });
        if !files.iter().any(|file| file == "session.xml") {
            return Err(
                "coverage report requires a regular session.xml file, not a symlink".to_string(),
            );
        }
        for file in &files {
            if file.contains(['\\', ':']) {
                return Err(format!("unsupported coverage report file name: {file}"));
            }
        }

        // Check before creating directories: output inside the input report would
        // change that report and could recursively copy earlier output bundles.
        let output = resolve_output_path(output)?;
        if output.starts_with(&report_root) {
            return Err("coverage output must be outside the input report directory".to_string());
        }
        fs::create_dir_all(&output)
            .map_err(|err| format!("cannot create coverage output directory: {err}"))?;
        let directory = tempfile::Builder::new()
            .prefix("coverage-")
            .tempdir_in(&output)
            .map_err(|err| format!("cannot create bundled coverage directory: {err}"))?;

        for file in &files {
            let source = fs::canonicalize(report_root.join(file))
                .map_err(|err| format!("cannot open coverage file '{file}': {err}"))?;
            if !source.starts_with(&report_root) || !source.is_file() {
                return Err(format!(
                    "coverage file escaped the report directory: {file}"
                ));
            }
            let destination = directory.path().join(file);
            fs::create_dir_all(destination.parent().expect("report file has a parent"))
                .map_err(|err| format!("cannot create coverage subdirectory: {err}"))?;
            fs::copy(&source, &destination)
                .map_err(|err| format!("cannot copy coverage file '{file}': {err}"))?;
        }

        let name = report_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("coverage report");
        let manifest = Manifest {
            name,
            root: config.root.as_deref(),
            files: &files,
        };
        let json = serde_json::to_vec(&manifest)
            .map_err(|err| format!("cannot encode coverage manifest: {err}"))?;
        fs::write(directory.path().join("manifest.json"), json)
            .map_err(|err| format!("cannot write coverage manifest: {err}"))?;
        let directory_name = directory
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("bundled coverage directory name is not UTF-8")?;
        let manifest_url = format!("./{directory_name}/manifest.json");
        Ok(Self {
            directory,
            manifest_url,
        })
    }

    pub(crate) fn manifest_url(&self) -> &str {
        &self.manifest_url
    }

    pub(crate) fn persist(self) {
        let _ = self.directory.keep();
    }
}

// Resolve existing symlink ancestors and lexical '..' before creating missing
// output directories, so an alias cannot bypass the input/output overlap check.
fn resolve_output_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path)
        .map_err(|err| format!("cannot resolve output directory: {err}"))?;
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            component => {
                resolved.push(component.as_os_str());
                if resolved.exists() {
                    resolved = fs::canonicalize(&resolved)
                        .map_err(|err| format!("cannot resolve output directory: {err}"))?;
                }
            }
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (TempDir, CoverageConfig) {
        let report = tempfile::tempdir().unwrap();
        fs::write(report.path().join("session.xml"), "<session/>").unwrap();
        fs::create_dir(report.path().join("pages")).unwrap();
        fs::write(report.path().join("pages/detail page.html"), "report text").unwrap();
        fs::write(report.path().join("ignored.bin"), "not needed").unwrap();
        let config = CoverageConfig {
            report_path: report.path().to_str().unwrap().to_string(),
            root: Some("tb.dut".to_string()),
        };
        (report, config)
    }

    #[test]
    fn bundles_report_and_cleans_up_only_unpublished_copies() {
        let (report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let bundle = BundledCoverage::prepare(&config, output.path()).unwrap();
        let copied = bundle.directory.path().to_owned();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(copied.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["root"], "tb.dut");
        assert_eq!(
            manifest["files"],
            serde_json::json!(["pages/detail page.html", "session.xml"])
        );
        assert_eq!(
            fs::read(copied.join("pages/detail page.html")).unwrap(),
            b"report text"
        );
        assert!(!copied.join("ignored.bin").exists());
        drop(bundle);
        assert!(!copied.exists());
        assert!(report.path().join("session.xml").exists());

        let mut automatic_config = config;
        automatic_config.root = None;
        let automatic = BundledCoverage::prepare(&automatic_config, output.path()).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(automatic.directory.path().join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert!(manifest.get("root").is_none());

        let published = BundledCoverage::prepare(&automatic_config, output.path()).unwrap();
        let published_path = published.directory.path().to_owned();
        published.persist();
        let next = BundledCoverage::prepare(&automatic_config, output.path()).unwrap();
        assert_ne!(next.directory.path(), published_path);
        drop(next);
        assert!(published_path.join("manifest.json").exists());
    }

    #[test]
    fn refuses_to_create_output_inside_the_report() {
        let (report, config) = fixture();
        let output = report.path().join("new/nested");
        assert!(BundledCoverage::prepare(&config, &output).is_err());
        assert!(!report.path().join("new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_output_aliases_and_external_session_symlinks() {
        let (report, config) = fixture();
        let aliases = tempfile::tempdir().unwrap();
        let alias = aliases.path().join("report-alias");
        std::os::unix::fs::symlink(report.path(), &alias).unwrap();
        assert!(BundledCoverage::prepare(&config, &alias.join("new")).is_err());
        assert!(!report.path().join("new").exists());

        fs::remove_file(report.path().join("session.xml")).unwrap();
        let external = aliases.path().join("outside.xml");
        fs::write(&external, "<session/>").unwrap();
        std::os::unix::fs::symlink(external, report.path().join("session.xml")).unwrap();
        assert!(BundledCoverage::prepare(&config, aliases.path()).is_err());
    }
}
