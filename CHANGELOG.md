# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a manual `hier-viewer update` command that downloads GitHub release binaries with staged terminal progress for release lookup, asset resolution, download, extraction, and in-place installation.
- Added a treemap `Select` mode that keeps a node pinned with a locked hover card on single-click, enters child hierarchy or opens source on double-click, persists the mode across reloads, and exposes an explicit dismiss control for clearing the selection.

### Changed

- Split the embedded viewer page source into dedicated HTML shell, CSS, body, and inline app-script files so the bundle template is easier to maintain without changing the generated output format.
- Release publishing now uses the matching `CHANGELOG.md` version section as the GitHub release body instead of relying on auto-generated release notes.
- Tightened the embedded `slang-hier-exporter` static-linking policy so Windows release builds now use the static MSVC runtime and `x64-windows-static` vcpkg triplets, while documenting the macOS platform limit that prevents fully static executables there.
- Changed the embedded `slang-hier-exporter` runtime materialization path to prefer user-private runtime or cache directories, with a user-scoped fallback and explicit override via `HIER_VIEWER_EMBEDDED_EXPORTER_DIR`, instead of always sharing a single `/tmp/hier-viewer/...` path.
- Removed the special sibling-exporter runtime path so `cargo run` now resolves the hierarchy exporter the same way as released binaries, and logs the resolved exporter path consistently.

### Fixed

- Treemap selections in `Select` mode now stay pinned when the selected node is temporarily outside the visible treemap due to zoom, depth limiting, or collapsed hierarchy, with ancestor markers indicating where the hidden selection lives.
- Navigating back to ancestor treemap roots no longer clears a locked selection as long as the selected node still belongs to the currently visible subtree.

## [1.0.0] - 2026-03-24

### Added

- A standalone `slang-hier-exporter` written in C++ on top of `slang`, embedded into the Rust viewer binary and also emitted as a sibling binary for direct debugging.
- End-to-end RTL ingestion from positional inputs, filelists, or prebuilt sqlite databases, plus a ratatui startup wizard for interactive source selection and compiler flag setup.
- A static output bundle layout with preview serving support, cache-aware sqlite reuse, and build / runtime logging for both the Rust frontend generator and the C++ exporter.
- Multiple hierarchy visualizations, including treemap, 2D pie, and 3D chart views, along with drill-down navigation, breadcrumbs, matches, a hierarchy tree panel, and zen mode.
- Source browsing workflows for both module definitions and instance locations, including in-view search, bookmarks, fullscreen reading, and bundled source materialization for static serving.
- Analysis and sizing workflows for weighted signal bits, LOC, generic pattern analysis, legends, theme selection, persisted viewer settings, and saved UI state such as collapse state and bookmarks.
- A GitHub Actions release pipeline that builds platform-specific release archives for Linux, macOS, and Windows from `vX.Y.Z` tags.

### Changed

- Replaced the older Python / `pyslang` export flow with a standalone C++ `slang` exporter, removing the runtime dependency on Python package installation for normal viewer generation.
- Switched the default viewer output from a single oversized HTML artifact to a static directory bundle with split assets, making preview serving and large-design handling more practical.
- Moved the default embedded `slang` dependency pin to `v10.0`.
- Promoted the project to its first stable `1.0.0` release.

### Fixed

- Cross-platform release packaging issues in the embedded exporter build path, including Windows exporter naming and multi-platform release asset generation.
- Static dependency resolution for the standalone exporter build, especially around sqlite and zlib linking on Linux.
- A stale upstream `slang` pin that no longer fetched successfully during clean builds.
- GitHub Actions runner compatibility for macOS Intel and Apple Silicon release builds by moving to the supported `macos-15-intel` and `macos-15` runners.
- Release publication behavior so successfully built artifacts can still be attached even when other matrix targets fail, while still refusing to publish an empty release.
- Windows release dependency resolution by passing the vcpkg target triplet explicitly into the CMake exporter build for SQLite3 and zlib.
- Interrupted `slang` FetchContent checkouts by automatically discarding incomplete cached sources before reconfiguring.
- Release packaging now keeps the downloaded archive names platform-specific while restoring the actual executable name inside each archive to `hier-viewer` or `hier-viewer.exe`.

[Unreleased]: https://github.com/cyril0124/hier-viewer/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cyril0124/hier-viewer/releases/tag/v1.0.0
