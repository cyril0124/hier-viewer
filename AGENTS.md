# Project Agent Notes

## Implementation Bias

- When writing code in this project, prioritize performance first.
- Prefer simple, direct, efficient implementations over more abstract or layered designs when both satisfy the requirement.
- Avoid adding avoidable allocations, unnecessary indirection, or heavyweight machinery for straightforward paths.

## Rust Validation

- For any Rust change, run validation from the repo root before finishing:
  - `cargo check`
  - `cargo clippy --all-targets --all-features -- -D warnings`
- Treat any Rust or Clippy warning as a failure. Do not leave `dead_code`, style, or lint warnings behind.

## Build Script Logging

- Do not use `cargo:warning=` for normal informational progress logs in `build.rs`.
- Reserve real Cargo warnings for actual warning conditions. Regular build progress should go to normal stderr logging so `cargo check` / `cargo clippy` stay warning-free.
