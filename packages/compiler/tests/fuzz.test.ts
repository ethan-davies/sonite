import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { DiagnosticCollector } from "../src/diagnostics/diagnostic.js";
import { Lexer } from "../src/lexer/index.js";
import { Parser } from "../src/parser/index.js";

/**
 * Frontend fuzzing: any input must terminate without throwing.
 * Diagnostics or successful compile are both acceptable.
 *
 * Default iters are small for `pnpm test`. Override with FUZZ_ITERS.
 * Longer runs: `pnpm test:fuzz` / `pnpm test:fuzz:long`.
 *
 * When a crash is found, minimize and add under tests/crash-regressions/<id>/input.sn.
 */

const DEFAULT_ITERS = Number(process.env.FUZZ_ITERS ?? "40");

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const VALID_SNIPPETS = [
  `function main(): void { print("hi"); }`,
  `function main(): void { let x = 1; print(x); }`,
  `function id<T>(v: T): T { return v; }\nfunction main(): void { print(id(1)); }`,
  `async function main(): void { await sleep(0); }`,
  `function main(): void { try { throw new Error("x"); } catch (e) { print(1); } }`,
  `function main(): void { const f = (x: i32): i32 => x + 1; print(f(2)); }`,
  `struct Point { x: i32; y: i32; }\nfunction main(): void { let p = Point { x: 1, y: 2 }; print(p.x); }`,
];

const TOKENS = [
  "function",
  "main",
  "(",
  ")",
  ":",
  "void",
  "{",
  "}",
  "let",
  "const",
  "print",
  '"hi"',
  "1",
  "2.5",
  "+",
  "-",
  "*",
  "/",
  "if",
  "else",
  "while",
  "return",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "import",
  "export",
  "struct",
  "class",
  "interface",
  "<",
  ">",
  ",",
  ";",
  "=",
  "=>",
  "[",
  "]",
];

function randomBytes(rng: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += String.fromCharCode(Math.floor(rng() * 256));
  }
  return out;
}

function randomUnicode(rng: () => number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const cp = 0x80 + Math.floor(rng() * 0x0700);
    out += String.fromCodePoint(cp);
  }
  return out;
}

function tokenSoup(rng: () => number, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(TOKENS[Math.floor(rng() * TOKENS.length)]!);
  }
  return parts.join(" ");
}

function mutateSnippet(rng: () => number, source: string): string {
  if (source.length === 0) {
    return source;
  }
  const chars = [...source];
  const ops = Math.max(1, Math.floor(rng() * 8));
  for (let i = 0; i < ops; i += 1) {
    const kind = Math.floor(rng() * 4);
    const idx = Math.floor(rng() * chars.length);
    if (kind === 0 && chars.length > 0) {
      chars.splice(idx, 1);
    } else if (kind === 1) {
      chars.splice(idx, 0, String.fromCharCode(32 + Math.floor(rng() * 95)));
    } else if (kind === 2 && chars.length > 0) {
      chars[idx] = String.fromCharCode(32 + Math.floor(rng() * 95));
    } else if (kind === 3 && chars.length > 2) {
      const end = Math.min(chars.length, idx + 1 + Math.floor(rng() * 5));
      chars.splice(idx, end - idx);
    }
  }
  return chars.join("");
}

function deepNest(rng: () => number, depth: number): string {
  let body = "print(1);";
  for (let i = 0; i < depth; i += 1) {
    if (rng() < 0.5) {
      body = `if (true) { ${body} }`;
    } else {
      body = `{ ${body} }`;
    }
  }
  return `function main(): void { ${body} }`;
}

function assertNoThrow(label: string, source: string): void {
  try {
    const result = compile(source, { fileName: `fuzz-${label}.sn`, debugInfo: false });
    expect(typeof result.success).toBe("boolean");
    expect(Array.isArray(result.diagnostics)).toBe(true);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(
      `Fuzz crash (${label}): compiler threw.\n--- source ---\n${source.slice(0, 2000)}\n--- error ---\n${message}`,
    );
  }
}

function assertLexerParserNoThrow(label: string, source: string): void {
  try {
    const diagnostics = new DiagnosticCollector();
    const tokens = new Lexer(source, diagnostics).tokenize();
    new Parser(tokens, diagnostics).parse();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(
      `Fuzz crash (${label}): lexer/parser threw.\n--- source ---\n${source.slice(0, 2000)}\n--- error ---\n${message}`,
    );
  }
}

describe("compiler frontend fuzz", () => {
  it("empty / whitespace / comments do not throw", () => {
    for (const source of ["", "   \n\t  ", "// only comment\n", "/* block */"]) {
      assertLexerParserNoThrow("trivial", source);
      assertNoThrow("trivial", source);
    }
  });

  it("random bytes and unicode do not throw", () => {
    const rng = mulberry32(0x5f022);
    for (let i = 0; i < DEFAULT_ITERS; i += 1) {
      assertLexerParserNoThrow(`bytes-${i}`, randomBytes(rng, 1 + Math.floor(rng() * 64)));
      assertLexerParserNoThrow(`uni-${i}`, randomUnicode(rng, 1 + Math.floor(rng() * 32)));
    }
  });

  it("token soup does not throw", () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < DEFAULT_ITERS; i += 1) {
      const source = tokenSoup(rng, 4 + Math.floor(rng() * 40));
      assertLexerParserNoThrow(`tokens-${i}`, source);
      assertNoThrow(`tokens-${i}`, source);
    }
  });

  it("mutated valid programs do not throw", () => {
    const rng = mulberry32(0xdeadbeef);
    for (let i = 0; i < DEFAULT_ITERS; i += 1) {
      const base = VALID_SNIPPETS[Math.floor(rng() * VALID_SNIPPETS.length)]!;
      const source = mutateSnippet(rng, base);
      assertNoThrow(`mut-${i}`, source);
    }
  });

  it("truncated programs do not throw", () => {
    const rng = mulberry32(0x1234567);
    for (let i = 0; i < DEFAULT_ITERS; i += 1) {
      const base = VALID_SNIPPETS[Math.floor(rng() * VALID_SNIPPETS.length)]!;
      const cut = Math.floor(rng() * (base.length + 1));
      assertNoThrow(`trunc-${i}`, base.slice(0, cut));
    }
  });

  it("deeply nested programs do not throw", () => {
    const rng = mulberry32(0xabcdef);
    for (let i = 0; i < Math.min(DEFAULT_ITERS, 20); i += 1) {
      const depth = 10 + Math.floor(rng() * 40);
      assertNoThrow(`nest-${i}`, deepNest(rng, depth));
    }
  });
});
