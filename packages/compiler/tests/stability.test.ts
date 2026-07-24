import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Invalid-input stability: ordinary bad programs must yield diagnostics, never throw.
 */
describe("invalid input stability", () => {
  const cases: { name: string; source: string }[] = [
    { name: "missing brace", source: `function main(): void { print(1);` },
    { name: "extra paren", source: `function main(): void { print(1)); }` },
    { name: "bad keyword soup", source: `function function(): void {}` },
    { name: "invalid operator", source: `function main(): void { let x = 1 @@ 2; }` },
    { name: "bad import", source: `import { x } from "";\nfunction main(): void {}` },
    { name: "bad generic arity", source: `function id<T>(v: T): T { return v; }\nfunction main(): void { id<i32, i32>(1); }` },
    { name: "unterminated string", source: `function main(): void { print("hi); }` },
    { name: "nested junk", source: `{{{{{((((***)))}}}}}` },
  ];

  for (const c of cases) {
    it(`does not throw on ${c.name}`, () => {
      expect(() =>
        compile(c.source, { fileName: `${c.name}.sn`, debugInfo: false }),
      ).not.toThrow();
      const result = compile(c.source, {
        fileName: `${c.name}.sn`,
        debugInfo: false,
      });
      expect(result.success).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  }
});
