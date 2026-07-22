# Progress

Living checklist for **typescript-native** — what’s done, what’s in flight, and what’s still ahead.

Last updated: 2026-07-22

---

## Vision

Build a programming language with TypeScript-like syntax that ahead-of-time compiles to native code via LLVM. The compiler itself is written in TypeScript (Node.js).

Target pipeline:

```
.tsn source → lexer → parser → validate → typecheck → LLVM IR → clang (bundled/cached) → native binary
```

---

## Done

### Project scaffolding
- [x] pnpm workspace monorepo (Node 20+)
- [x] `@typescript-native/compiler` — lexer, parser, validate, typecheck, codegen, formatter
- [x] `@typescript-native/cli` — `tsn` CLI (depends on compiler)
- [x] `@typescript-native/runtime` — C runtime (`libtsn_runtime.a`)
- [x] `@typescript-native/std` — standard library (prelude + modules)
- [x] `@typescript-native/lsp` / VS Code extension
- [x] Strict TypeScript configs (`tsconfig.base.json` + per-package)
- [x] Vitest in the compiler package
- [x] `.gitignore`, `.editorconfig`, VS Code workspace hints
- [x] `README.md`, MIT `LICENSE`
- [x] Examples under `examples/`

### Compiler pipeline (working)
- [x] `compile()` / `compileFile()` API in `@typescript-native/compiler`
- [x] Diagnostic collector with source spans and severity
- [x] Formatted diagnostic output for the CLI
- [x] Post-parse validation requiring exactly one `main(): void` (other functions allowed)
- [x] Type checker for the current language surface
- [x] Source formatter (`formatSource` / `tsn fmt`) — parse → pretty-print; comments not preserved yet

### CLI / toolchain
- [x] `tsn` entrypoint using **Commander**
- [x] `project.toml` project manifest (name, version, entry, build.outdir, …)
- [x] `tsn init` — scaffold project
- [x] `tsn build` — compile project entry to native binary in `dist/`
- [x] `tsn run [file]` — single-file or project build+run
- [x] `tsn fmt [--check]` — format `.tsn` files
- [x] `tsn compile` — emit LLVM IR
- [x] `tsn <file.tsn>` — shorthand for `run`
- [x] Clang resolution: `TSN_CLANG` → system PATH → download/cache pinned LLVM under `~/.cache/tsn/`
- [x] `pnpm dev` builds the compiler then runs the CLI via `tsx`

### Language surface
(See README for the full feature list — modules, generics, classes, interfaces, control flow, exceptions, std, etc.)

---

## Next up

Add features one at a time (implement end-to-end when adding — no stubs):

1. **Formatter polish** — preserve comments; optional style config
2. **CLI polish** — `--emit-ast`, colored diagnostics, keep temp binaries on failure
3. **Project dependencies** — `[dependencies]` in `project.toml` when a package story exists

---

## Deferred / later

- [ ] Package registry / dependency resolution
- [ ] Cross-compilation targets
- [ ] Memory model / GC maturity
- [ ] CI (GitHub Actions: typecheck + test + build)

---

## Known limitations (today)

| Area | Limitation |
| --- | --- |
| Formatter | Comments are stripped; style is fixed (2-space, K&R braces) |
| Native binary | First-time clang download (if no system clang) fetches a large LLVM archive (~1–2 GB) into `~/.cache/tsn/` |
| Strings | Concat allocates via `tsn_alloc` (no automatic free yet) |

---

## How to work from this file

1. Pick the top item under **Next up**.
2. Implement it fully (lexer → IR) behind tests — no half-stubs for unused features.
3. Check it off here and adjust **Known limitations**.
4. Keep the README high-level; keep detailed status here.
