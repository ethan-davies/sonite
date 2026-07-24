# Prebuilt runtime archives

Place the static runtime library here for each supported platform:

| Platform | Artifact |
| --- | --- |
| `linux-x64/` | `libsn_runtime.a` |
| `linux-arm64/` | `libsn_runtime.a` |
| `macos-x64/` | `libsn_runtime.a` |
| `macos-arm64/` | `libsn_runtime.a` |
| `win32-x64/` | `sn_runtime.lib` |
| `win32-arm64/` | deferred |

Produced by `pnpm --filter @sonite/runtime build` (Unix) or `make -f Makefile.win` (Windows), which copies into `prebuilt/<host>/`.

Windows builds are **minimal** (print / strings / GC / alloc). Async reactor, net, and TLS are not available on Windows in this milestone.
