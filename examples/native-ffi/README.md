# Native FFI example

Demonstrates Phase 5 public FFI and package-local native linking:

1. `extern function` with `@symbol`
2. `@repr("C")` struct
3. `Ptr<T>` and `FnPtr`
4. Bundled static library via `[native]` + `native/<platform>/`

For the package-manager distribution model (install → lockfile → transitive link), see [docs/native-packages.md](../../docs/native-packages.md).

## Build the C library (once per platform)

```bash
cc -c -O2 -fPIC native/sn_example.c -o /tmp/sn_example.o -I native
mkdir -p native/linux-x64   # or linux-arm64, macos-x64, macos-arm64
ar rcs native/linux-x64/libsn_example.a /tmp/sn_example.o
```

On Windows (MSVC or compatible):

```bat
cl /c /O2 native\sn_example.c /I native /Fo%TEMP%\sn_example.obj
lib /OUT:native\win32-x64\sn_example.lib %TEMP%\sn_example.obj
```

A prebuilt `native/linux-x64/libsn_example.a` is checked in for Linux x64 CI.

## Run

From the repo root (with the Sonite CLI built):

```bash
cd examples/native-ffi
sn build
./dist/native-ffi-example
```

Expected output includes `42` (20+22) and a callback print of that value.

## Flow

```text
Sonite FFI
    ↓
extern declaration
    ↓
Native function (sn_example_*)
    ↓
Native library (libsn_example.a)
    ↓
[native] in project.toml
    ↓
sn build → LLD
    ↓
Executable
```
