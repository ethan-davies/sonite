# typescript-native

**typescript-native** is a programming language with TypeScript-like syntax that compiles to native code through LLVM. The compiler is written in TypeScript and exposed as the `tsn` CLI.

```ts
function main(): void {
  const name = "world";
  print("Hello", name);
}
```

```bash
pnpm install
pnpm dev examples/hello.tsn
# Hello, world!
```

## Packages

This repository is a pnpm workspace:

| Package | Name | Role |
| --- | --- | --- |
| [`packages/compiler`](./packages/compiler) | `@typescript-native/compiler` | Lexer, parser, validation, typecheck, LLVM codegen |
| [`packages/runtime`](./packages/runtime) | `@typescript-native/runtime` | C runtime (`libtsn_runtime.a`) for print, strings, arrays, maps |
| [`packages/std`](./packages/std) | `@typescript-native/std` | Standard library written in TSN (prelude + modules) |
| [`packages/cli`](./packages/cli) | `@typescript-native/cli` | `tsn` command-line tool |
| [`packages/lsp`](./packages/lsp) | `@typescript-native/lsp` | Language server (diagnostics, hover, definition, completion, symbols) |
| [`packages/vscode`](./packages/vscode) | `typescript-native-vscode` | TextMate grammar + VS Code / Cursor extension (LSP client) |

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+

`tsn build` / `tsn run` link native binaries with clang. The CLI uses clang from `TSN_CLANG`, then `PATH`, then a cached LLVM download under `~/.cache/tsn/` (no manual clang install required).

## Getting started

```bash
pnpm install
pnpm dev examples/hello.tsn
```

`pnpm dev` builds the compiler, then runs the CLI from the repo root. After a full workspace build:

```bash
pnpm build
node packages/cli/dist/cli.js examples/hello.tsn
```

Try the variables example next:

```bash
pnpm dev examples/variables.tsn
```

## CLI

| Command | Description |
| --- | --- |
| `tsn init [dir]` | Create a new project (`project.toml`, `src/main.tsn`) |
| `tsn build` | Build the current project to `dist/<name>` |
| `tsn run [file]` | Run a file, or build and run the current project |
| `tsn fmt [paths…]` | Format `.tsn` sources (`--check` for CI) |
| `tsn compile [file]` | Emit LLVM IR (`<file>.ll` or project entry) |
| `tsn <file.tsn>` | Shorthand for `tsn run <file.tsn>` |

### `project.toml`

Projects are configured with a Cargo-like manifest at the repo root:

```toml
[package]
name = "hello"
version = "0.1.0"
description = ""
license = "MIT"
authors = []
entry = "src/main.tsn"

[build]
outdir = "dist"
```

### Toolchain

Native linking uses clang in this order:

1. `TSN_CLANG` — explicit path to a clang binary
2. `clang` on `PATH`
3. Cached LLVM under `~/.cache/tsn/llvm-<version>/` (downloaded on first need)

Override the cache root with `TSN_CACHE_DIR` if desired.

During development:

```bash
pnpm dev examples/hello.tsn
pnpm dev run examples/hello.tsn
pnpm dev compile examples/hello.tsn -o hello.ll
pnpm dev init ./my-app
pnpm --filter @typescript-native/cli exec tsn build   # from a project directory
pnpm dev fmt --check
```

## Language

Programs are stored in `.tsn` files. Every program must define `function main(): void` — that is the entry point.

**Currently supported:**

- A single top-level `function main(): void` with no parameters (return type required)
- Types: `i32`, `i64`, `f32`, `f64`, `bool`, `string`, `char`, `void`, `null`, arrays `T[]`, tuples `[T, U]`, `struct`, `enum`, `class`, and `interface` types
- Generics: type parameters on structs, classes, interfaces, functions, and methods; constraints (`T extends I`); nested type arguments; call-site inference; compile-time monomorphization (no runtime generics)
- Type aliases (`type Name = ...`), including generic aliases, unions (`|`), intersections (`&`), literal types, `keyof` / `typeof` type operators, conditional and mapped types
- Control-flow narrowing via `typeof` checks, `== null` / `!= null`, and `is` type checks on union / nullable values; early `return` / `break` / `continue` refine types in subsequent code
- Index signatures (`[key: string]: T`) as string-keyed maps
- Struct declarations, literals (`Person { name: "...", age: 16 }`), field access, field assignment, and instance methods
- Classes: `new`, constructors, instance/static fields and methods, `public`/`private`, `readonly`, inheritance (`extends`), and `abstract` classes (heap reference types)
- Interfaces: method contracts with `implements` / `extends`, optional index signatures, compile-time compliance checks, and fat-pointer dynamic dispatch when typed as an interface
- `let` / `const` variables with optional annotations and inference (`5` → `i32`, `3.14` → `f64`); annotated `let` may omit an initializer (`let x: T | null;`); tuple destructuring (`let [a, b] = pair`)
- Reassignment for `let` only (`=`, `+=`, `-=`, `++`, `--` on numeric lets)
- Arrays: literals `[1, 2, 3]`, indexing, element assignment, `.length`, and prelude methods (`.push` / `.pop` / `.includes` / `.indexOf` / `.map` / `.filter` / `.reduce` / `.join` / `.concat` / …)
- String methods via the auto-loaded prelude (`.contains`, `.startsWith`, `.trim`, `.toUpperCase`, `.indexOf`, `.padStart`, `.join`, …)
- Extension methods: `export function contains(this: string, needle: string): bool` callable as `"hi".contains("h")`
- `extern function` declarations for calling C runtime symbols from TSN
- Explicit standard-library modules via `import { … } from "std/…"` (`std/math`, `std/random`, `std/collections`; `std/strings` / `std/io` reserved for future specialized APIs)
- Tuples: fixed-length heterogeneous products `[string, i32]`, const/dynamic indexing (dynamic → union), `.length`, element assignment with constant indexes, destructuring with holes
- Function types `(i32, i32) => i32`: annotate variables, parameters, and return types; use in `type` aliases; assign and pass named functions as first-class values; call through function-typed expressions
- Default parameter values (`greeting: string = "Hello"`) evaluated at the call site when omitted; required parameters must precede defaults
- Named call arguments (`createPerson(age: 16, name: "Ethan")`), any order, mixed with leading positionals; can skip middle defaults (`configure(host, secure: true)`). Defaults and named args apply only to direct function/method references — not through function-typed values
- Arrow lambdas `(a: i32, b: i32) => a + b` and block bodies; contextual typing from an expected function type; closures with capture-by-reference for `let` (heap boxes) and by-value for `const` (no generic lambdas yet)
- Literals: integers, floats, booleans, strings, chars, `null`
- `print(...)` of printable values; multiple args are joined with spaces (compiler intrinsic, available through the prelude)
- String concatenation with `+`
- Comparisons (`== != < <= > >=`) and logical ops (`&& || !`)
- Value-position `typeof` expression (returns type tags such as `"string"`, `"i32"`, `"bool"`, `"null"`, `"object"`)
- `value is Type` type checks (including `is null` and class types) with narrowing
- Control flow: `if` / `elseif` / `else`, `while`, C-style `for`, element `for (i in arr)`, `switch` / `case` / `default`, `break`, `continue`
- Exceptions: built-in `Error` class (`message`), `throw`, `try` / `catch` / `finally` (every thrown value must be `Error` or a subclass)
- `//` line comments and `/* */` block comments

`print` is a builtin. It is lowered to `tsn_print_*` runtime calls in the generated LLVM IR, and `tsn run` links `libtsn_runtime.a` when building the native binary.
`createMap()` is a builtin that allocates an empty string-keyed map (for index-signature types).

### Examples

| File | Demonstrates |
| --- | --- |
| [`examples/hello.tsn`](./examples/hello.tsn) | Minimal `main` + `print` |
| [`examples/variables.tsn`](./examples/variables.tsn) | Types, inference, `let`/`const`, concat, multi-arg `print` |
| [`examples/arithmetic.tsn`](./examples/arithmetic.tsn) | Arithmetic and precedence |
| [`examples/control-flow.tsn`](./examples/control-flow.tsn) | `if` / `elseif` / `else`, comparisons |
| [`examples/loops.tsn`](./examples/loops.tsn) | `for` / `while`, updates, `break` / `continue` |
| [`examples/switch.tsn`](./examples/switch.tsn) | `switch` / `case` / `default`, fallthrough, enum cases |
| [`examples/errors.tsn`](./examples/errors.tsn) | `Error`, `throw`, `try` / `catch` |
| [`examples/finally-return.tsn`](./examples/finally-return.tsn) | `finally` with `return` |
| [`examples/arrays.tsn`](./examples/arrays.tsn) | Array literals, indexing, methods, `for-in` |
| [`examples/prelude.tsn`](./examples/prelude.tsn) | Auto-loaded prelude: string/array methods without imports |
| [`examples/std-math.tsn`](./examples/std-math.tsn) | Explicit `std/math` imports (`sqrt`, `abs`, …) |
| [`examples/std-random.tsn`](./examples/std-random.tsn) | Explicit `std/random` imports (`random`, `randomInt`, …) |
| [`examples/std-collections.tsn`](./examples/std-collections.tsn) | `Stack` / `Queue` / `Set` / `List` from `std/collections` |
| [`examples/tuples.tsn`](./examples/tuples.tsn) | Tuple types, indexing, destructuring, generics |
| [`examples/structs.tsn`](./examples/structs.tsn) | Struct decls, literals, fields, params |
| [`examples/struct-methods.tsn`](./examples/struct-methods.tsn) | Struct instance methods with `this` |
| [`examples/classes.tsn`](./examples/classes.tsn) | Classes, `new`, constructors, static/readonly/private |
| [`examples/inheritance.tsn`](./examples/inheritance.tsn) | Abstract classes, `extends`, virtual methods |
| [`examples/interfaces.tsn`](./examples/interfaces.tsn) | Interfaces, `implements`, itable dispatch |
| [`examples/generics.tsn`](./examples/generics.tsn) | Generic structs/classes/functions/methods, constraints, inference |
| [`examples/type-aliases.tsn`](./examples/type-aliases.tsn) | Type aliases and literal unions |
| [`examples/unions.tsn`](./examples/unions.tsn) | Union types and typeof narrowing |
| [`examples/nullability.tsn`](./examples/nullability.tsn) | `null`, nullable types, `is` checks, CFA narrowing |
| [`examples/multi-constraints.tsn`](./examples/multi-constraints.tsn) | Multi-constraints (`T extends A & B`) |
| [`examples/dictionaries.tsn`](./examples/dictionaries.tsn) | Index signatures as string-keyed maps |
| [`examples/type-operators.tsn`](./examples/type-operators.tsn) | `keyof` / `typeof` / conditionals / mapped types / `T[K]` |
| [`examples/function-types.tsn`](./examples/function-types.tsn) | Function type annotations, aliases, named functions as values |
| [`examples/default-named-args.tsn`](./examples/default-named-args.tsn) | Default parameters and named call arguments |
| [`examples/lambdas.tsn`](./examples/lambdas.tsn) | Arrow lambdas, contextual typing, closures |

## Development

```bash
pnpm test          # compiler test suite
pnpm test:watch    # vitest watch mode
pnpm typecheck     # type-check all packages
pnpm build         # build compiler + CLI
```

## License

[MIT](./LICENSE)
