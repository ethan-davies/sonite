# Native Packages

Sonite distributes native libraries as part of the package ecosystem. Consumers install Sonite packages; the package manager resolves, verifies, caches, and links native artifacts for the host platform.

```text
sn add sqlite-wrapper
        │
        ▼
sn install  →  resolve Sonite + native  →  verify SHA-256  →  lockfile
        │
        ▼
sn build    →  link static/dynamic/system natives  →  executable
```

See also [FFI language reference](ffi.md).

## Declaring native dependencies

A package that ships native code declares it in `project.toml`:

```toml
[native]
name = "sqlite3"
version = "3.45.0"
kind = "static"          # static | dynamic
link = "auto"            # static | dynamic | auto (default)
libraries = ["sqlite3"]
headers = ["native/include/sqlite3.h"]

[native.linux-x64]
library = "libsqlite3.a"

[native.macos-arm64]
library = "libsqlite3.a"

[native.win32-x64]
library = "sqlite3.lib"
```

Consumers depend on the **Sonite** package as usual:

```toml
[dependencies]
sqlite-wrapper = "^1.0.0"
```

Native requirements are resolved transitively from each dependency’s `[native]` section.

### System libraries

Libraries that must come from the OS (never downloaded):

```toml
[native.system]
libraries = ["pthread"]
```

Platform-specific linker arguments:

```toml
[native.linux]
link_args = ["-pthread"]

[native.macos]
link_args = ["-framework", "Security"]

[native.windows]
link_args = ["ws2_32"]
```

### Local / bundled layout

```text
package/
├── project.toml
├── src/
└── native/
    ├── linux-x64/
    ├── linux-arm64/
    ├── macos-x64/
    ├── macos-arm64/
    └── win32-x64/          # `windows-x64` is accepted as an alias
```

Supported Phase 5 targets: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `win32-x64`. Windows ARM64 is unsupported; install fails early if the host target is missing.

## Static vs dynamic

| Kind | Linux / macOS | Windows |
| --- | --- | --- |
| Static | `.a` | `.lib` |
| Dynamic | `.so` / `.dylib` | `.dll` (+ `.lib` import library) |

`link = "auto"` prefers static artifacts when both are present. Dynamic libraries are copied next to the built binary; Unix builds set `$ORIGIN` / `@loader_path` rpath so users do not need `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH`.

## Install, lockfile, and cache

`sn install` / `sn add` / `sn update`:

1. Resolve the Sonite dependency graph.
2. Collect native metadata from each installed package.
3. Select the host platform artifact (fail if missing).
4. Copy into the native cache and verify SHA-256.
5. Record `[[native]]` entries in `project.lock`.

Example lock entry:

```toml
[[native]]
package = "sqlite-wrapper"
name = "sqlite3"
version = "3.45.0"
platform = "linux"
architecture = "x64"
kind = "static"
source = "bundled"
path = "native/linux-x64/libsqlite3.a"
sha256 = "…"
filename = "libsqlite3.a"
```

Cache location (override with `SN_CACHE_DIR`):

```text
~/.cache/sonite/native/<name>/<version>/<platform>/
```

Clear with:

```bash
sn cache clean
```

Missing cache entries are re-materialized from the package store; the cache is never required for correctness.

## Publishing

`sn publish` packs the Sonite sources (including `native/`) and attaches native metadata to the registry version:

```json
{
  "native": {
    "linux-x64": {
      "kind": "static",
      "library": "libfoo.a",
      "sha256": "…",
      "path": "native/linux-x64/libfoo.a"
    }
  }
}
```

Publish validates platform directory names, rejects unknown/duplicate targets, and prints a per-target checklist.

## Build integration

`sn build` merges:

1. The current project’s `[native]` configuration.
2. Installed dependency `native/<platform>/` trees and lockfile artifact paths.
3. Explicit `[native.system]` libraries.

Search order is limited to those locations — arbitrary filesystem paths are not scanned.

## CLI messaging

Install reports Sonite and native packages separately (target, kind, SHA-256 verified). Adding a package that pulls native deps lists them under `Native dependencies:`.

## Diagnostics

| Failure | Meaning |
| --- | --- |
| Missing platform artifact | Package has no `native/<host>/` — fix at install, not link |
| Version conflict | Two packages require incompatible native identity versions |
| Integrity mismatch | Downloaded/cached bytes ≠ lockfile `sha256` |
| Missing runtime library | Dynamic `.so`/`.dylib`/`.dll` could not be copied beside the binary |

## Example

See [`examples/native-ffi`](../examples/native-ffi/) for FFI + bundled static library end-to-end.
