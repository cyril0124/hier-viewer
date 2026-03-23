# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Updated the GitHub Actions macOS Intel release job to use the supported `macos-15-intel` runner label after `macos-13` runner retirement.
- Updated the GitHub Actions macOS Apple Silicon release job to use `macos-15` for a newer supported Xcode toolchain.
- Adjusted the release workflow so a GitHub release can still publish any successfully built artifacts even if other matrix targets fail, while still failing when no release artifacts are produced.
- Passed the Windows vcpkg target triplet explicitly into the CMake exporter build so SQLite3 and zlib can be resolved reliably during release builds.
- Added recovery for incomplete cached `slang` FetchContent checkouts so interrupted builds can self-heal by discarding stale partial sources before reconfiguring.

## [1.0.0] - 2026-03-23

### Added

- A standalone `slang-hier-exporter` written in C++ on top of `slang`, embedded into the Rust viewer binary and also emitted as a sibling binary for direct debugging.
- End-to-end RTL ingestion from positional inputs, filelists, or prebuilt sqlite databases, plus a ratatui startup wizard for interactive source selection and compiler flag setup.
- A static output bundle layout with preview serving support, cache-aware sqlite reuse, and build / runtime logging for both the Rust frontend generator and the C++ exporter.
- Multiple hierarchy visualizations, including treemap, 2D pie, and 3D chart views, along with drill-down navigation, breadcrumbs, matches, a hierarchy tree panel, and zen mode.
- Source browsing workflows for both module definitions and instance locations, including in-view search, bookmarks, fullscreen reading, and bundled source materialization for static serving.
- Analysis and sizing workflows for weighted signal bits, LOC, generic pattern analysis, legends, theme selection, persisted viewer settings, and saved UI state such as collapse state and bookmarks.
- A GitHub Actions release pipeline that builds raw binaries for Linux, macOS, and Windows from `vX.Y.Z` tags.

### Changed

- Replaced the older Python / `pyslang` export flow with a standalone C++ `slang` exporter, removing the runtime dependency on Python package installation for normal viewer generation.
- Switched the default viewer output from a single oversized HTML artifact to a static directory bundle with split assets, making preview serving and large-design handling more practical.
- Moved the default embedded `slang` dependency pin to `v10.0`.
- Promoted the project to its first stable `1.0.0` release.

### Fixed

- Cross-platform release packaging issues in the embedded exporter build path, including Windows exporter naming and multi-platform release asset generation.
- Static dependency resolution for the standalone exporter build, especially around sqlite and zlib linking on Linux.
- A stale upstream `slang` pin that no longer fetched successfully during clean builds.

[Unreleased]: https://github.com/cyril0124/hier-viewer/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cyril0124/hier-viewer/releases/tag/v1.0.0
