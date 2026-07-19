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
| [`packages/cli`](./packages/cli) | `@typescript-native/cli` | `tsn` command-line tool |

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Clang](https://clang.llvm.org/) on your `PATH` (needed to run programs)

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
| `tsn <file.tsn>` | Compile with Clang and run |
| `tsn run <file.tsn>` | Same as above |
| `tsn compile <file.tsn>` | Emit LLVM IR (`<file>.ll` by default) |
| `tsn compile <file.tsn> -o out.ll` | Emit LLVM IR to a specific path |

During development:

```bash
pnpm dev examples/hello.tsn
pnpm dev run examples/hello.tsn
pnpm dev compile examples/hello.tsn -o hello.ll
```

## Language

Programs are stored in `.tsn` files. Every program must define `function main(): void` — that is the entry point.

**Currently supported:**

- A single top-level `function main(): void` with no parameters (return type required)
- Types: `i32`, `i64`, `f32`, `f64`, `bool`, `string`, `char`, `void`
- `let` / `const` variables with optional annotations and inference (`5` → `i32`, `3.14` → `f64`)
- Reassignment for `let` only
- Literals: integers, floats, booleans, strings, chars
- `print(...)` of printable values; multiple args are joined with spaces
- String concatenation with `+`
- `//` line comments and `/* */` block comments

`print` is a builtin. It is lowered to libc `printf` in the generated LLVM IR.

### Examples

| File | Demonstrates |
| --- | --- |
| [`examples/hello.tsn`](./examples/hello.tsn) | Minimal `main` + `print` |
| [`examples/variables.tsn`](./examples/variables.tsn) | Types, inference, `let`/`const`, concat, multi-arg `print` |

## Development

```bash
pnpm test          # compiler test suite
pnpm test:watch    # vitest watch mode
pnpm typecheck     # type-check all packages
pnpm build         # build compiler + CLI
```

## License

[MIT](./LICENSE)
