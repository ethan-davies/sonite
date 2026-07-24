# Packages, dependencies, and builds

Sonite projects are configured with `project.toml` and locked with `project.lock`.
The CLI (`sn`) resolves dependencies against the package registry and builds native binaries.

See also [native packages](native-packages.md) and [FFI](ffi.md).

## Dependency declarations

### Version requirements

```toml
[dependencies]
http = "^1.2.0"
json = "2.1.0"
```

Supported forms: exact (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`).

### Dependency overrides

Force a specific version everywhere in the graph:

```toml
[overrides]
bar = "2.0.0"
```

Overrides must be **exact** versions. If any package requires a range incompatible with the override, resolution fails with a clear diagnostic — overrides never silently violate semver constraints.

### Path dependencies

Local filesystem packages (no registry publish required):

```toml
[dependencies]
my-library = { path = "../my-library" }
```

Relative paths are resolved from the project root. Absolute paths are allowed. The lockfile records `source = "path:…"`. Nested path dependencies are supported.

### Development dependencies

```toml
[dev-dependencies]
test-utils = "1.0.0"
```

Semantics:

- Resolved and locked together with production dependencies for `sn install` / `sn update` / local development.
- Marked `dev = true` in `project.lock` when only reachable from `[dev-dependencies]`.
- When another project depends on your published package, only your `[dependencies]` are used as runtime requirements (not `[dev-dependencies]`).

### Git dependencies

**Not supported in v1.** Declaring `{ git = "…" }` is rejected. Prefer path dependencies for local development or publish to the registry.

## Commands

| Command | Purpose |
|---------|---------|
| `sn add <pkg>[@ver]` | Add a registry dependency |
| `sn remove <pkg>` | Remove a dependency |
| `sn install` | Install from lockfile (or resolve) |
| `sn update [pkg]` | Re-resolve; prints version diffs |
| `sn tree` | Print the locked dependency tree |
| `sn audit` | Check lockfile against registry advisories (non-zero exit on findings) |

## Build profiles

Default profiles:

```toml
[profile.debug]
optimization = 0
debug-info = true

[profile.release]
optimization = 2
debug-info = false
```

Custom profiles may set `inherits = "release"` (or another profile) and override fields.
`optimization` must be an integer `0`–`3` (maps to LLVM `O0`–`O3`). `Os`/`Oz` are not exposed.

```bash
sn build                 # debug → build/debug/<name>
sn build --release       # release profile
sn build --profile release
sn clean                 # remove build artifacts (not dependencies)
```

Default `[build] outdir` is `build`. Output layout is `<outdir>/<profile>/<binary>`.

Cross-compilation (`--target`) is **not** supported yet. Only host platforms with a full Sonite toolchain are valid (Linux/macOS x64 & arm64, Windows x64).

Incremental compile caching is deferred; every `sn build` recompiles. Package and native artifact caches still apply.

## Workspaces

Sonite multi-package workspaces are **deferred** past v1.0.0. Use path dependencies for related local packages.

## Registry & ownership

```bash
sn login / sn logout
sn publish
sn search <query>
sn info <name>
sn deprecate <pkg>[@ver] --reason "…" [--replacement …]
sn owner list <pkg>
sn owner add <pkg> <username>
sn owner remove <pkg> <username>
sn owner transfer <pkg> <username>
```

Package documentation metadata in `project.toml` (`description`, `license`, `repository`, `documentation`, `keywords`) is sent on publish and shown by `sn info` / `sn search`.

### Deletion policy

- Published versions cannot normally be deleted.
- Prefer **deprecation** (warns on install/search/info; does not break lockfiles).
- Permanent deletion is reserved for administrators (malicious/illegal content) and is not a public CLI operation.

### CI

Non-interactive workflow:

```bash
sn install
sn build --release
sn fmt --check
sn audit
```

Authentication for publish/owner operations uses the saved login token, or set `SN_REGISTRY_TOKEN` (and optionally `SN_REGISTRY_URL`) in the environment.

## Provenance

`project.lock` records package version, source (registry URL or path), integrity checksum, optional `override` / `dev` flags, and when available `published_by` / `published_at`.
