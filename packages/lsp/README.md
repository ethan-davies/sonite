# @typescript-native/lsp

Language server for TypeScript Native (`.tsn`).

## Run

```bash
pnpm --filter @typescript-native/compiler build
pnpm --filter @typescript-native/lsp build
node packages/lsp/dist/server.js --stdio
```

Speaks LSP over stdio. Used by `typescript-native-vscode`.

## Features

- Diagnostics (lexer / parser / validate / typecheck via `analyzeFile`)
- Hover
- Go to definition
- Completion (keywords, in-scope bindings, module symbols, members after `.`)
- Document symbols
