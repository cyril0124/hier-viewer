# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Clearing a hierarchy filter or entering an invalid regex refreshes Matches and Tree instead of leaving stale results and highlights.
- Chart drill-down retains matches inherited from ancestors; deep chart, tree-panel, and analysis traversals no longer overflow the JavaScript stack.
- Broad hierarchy filters stop revisiting already processed ancestors, avoiding quadratic work on deep designs.
- Closing or switching the source reader cancels pending rendering and progress updates, and loading a new file clears the previous search and bookmark context.
- Plain-text source search preserves input focus; virtualized source rows keep stable scroll geometry and reveal long-line matches horizontally.
- Chart content remains scrollable on short or narrow viewports instead of clipping the plot and legend, and the 3D Fit camera frames the complete height of the bars.
- Wizard input preserves wildcard and regex expressions unless a completion is explicitly selected, and retains quoting for CLI flags containing spaces or quotes.
- Filelists containing compiler options or inline comments are accepted; slang validates missing sources and invalid options directly.
- 3D charts fit their complete geometry to the available viewport, including narrow screens, without stretching the canvas or cropping tall bars. Zoom status continues updating after Fit.
- Advanced settings stay within narrow viewports and have an explicit close button.
- Parameterized instances now retain their own elaborated signal widths and generate-dependent counts instead of reusing the first instance's statistics.
- Cached exports are invalidated when an actual source dependency, including an included header, changes or disappears.
- Bundled source paths no longer collide when different source directories share filenames, and source URLs encode reserved characters in directory and file names.
- Analysis charts refresh when lazy-loaded signal data finishes loading or fails.
- Preview requests with query parameters resolve to the requested file instead of returning an incorrect 404.
- Multi-configuration CMake generators use the selected build profile and emit the exporter at the path expected by Cargo.

### Changed

- Updated both READMEs with first-install instructions, source-build requirements, input scanning and parameterized statistics behavior, source availability requirements, and the regression-test workflow.
- Redesigned the viewer as a compact, full-width workspace with GitHub Light as the default theme, embedded Lucide toolbar icons, sans-serif chart labels, and flatter panels and source controls. Existing saved themes remain selected.
- Improved small-screen control wrapping and chart sizing, added keyboard focus and reduced-motion styles, and kept status errors visible without persistent instructional text.
- Removed unused source-snippet extraction from bundle generation and compute hierarchy statistics iteratively without cloning child lists.
- Explicit RTL paths, directories, absolute globs, and filelist-only input skip the workspace-wide RTL index; the wizard and relative wildcard searches still build it.
- Signal analysis matches each shared definition once per pattern update, and hierarchy depth and analysis totals use iterative traversal for wide and deep trees.
- Exporter statistics reuse slang's canonical elaborated instance bodies and avoid copying signal-detail vectors for each instance.

- Tightened the Cargo package contents for source-based installation and updated the install docs to recommend GitHub release binaries first, with `cargo install --git` / `cargo install --path` documented as advanced source-install options.
- Selecting `Weighted Signal Bits` as the treemap sizing mode now defaults the layout to `Accurate`, and viewers that start with weighted sizing also initialize in `Accurate` layout by default.
- Raised the large-source plain-text fallback thresholds so source files around a few hundred thousand lines keep the virtualized highlighted renderer, preserving syntax coloring and search navigation for large RTL files such as 220k-line drops.
- Plain-text large-source fallback now keeps search, bookmark, and focus jumps navigable by explicitly scrolling the textarea viewport to the selected line.

## [1.1.1] - 2026-03-25

### Fixed

- Filelist-driven sqlite cache invalidation now fingerprints the source paths referenced by command files as well, so deleting or changing files listed under `--filelist` no longer silently reuses a stale cached sqlite export.
- Treemap collapse `-/+` hover targets now show a small floating tooltip with the current instance name and module name, making it easier to confirm exactly which node will fold before clicking.

## [1.1.0] - 2026-03-24

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

- GitHub release publishing now checks out the repository before extracting release notes from `CHANGELOG.md`, fixing release jobs that previously failed with `Build release notes from changelog`.
- Build recovery from stale cached `slang` FetchContent state is now more robust when recursive deletion hits transient non-empty-directory failures during cleanup.
- Treemap selections in `Select` mode now stay pinned when the selected node is temporarily outside the visible treemap due to zoom, depth limiting, or collapsed hierarchy, with ancestor markers indicating where the hidden selection lives.
- Navigating back to ancestor treemap roots no longer clears a locked selection as long as the selected node still belongs to the currently visible subtree.
- Treemap collapse `-/+` controls and tree-panel expand/collapse toggles now show a clear hover highlight so the fold target is easier to confirm before clicking.

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

[Unreleased]: https://github.com/cyril0124/hier-viewer/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/cyril0124/hier-viewer/releases/tag/v1.1.1
[1.1.0]: https://github.com/cyril0124/hier-viewer/releases/tag/v1.1.0
[1.0.0]: https://github.com/cyril0124/hier-viewer/releases/tag/v1.0.0
