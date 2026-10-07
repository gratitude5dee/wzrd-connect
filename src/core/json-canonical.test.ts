import { describe, expect, it } from "vitest";
import { canonicalJson, JsonCanonicalDepthError } from "./json-canonical.ts";

describe("canonicalJson", () => {
  it("orders object keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 1, a: 2, A: 3, aa: 4 })).toBe('{"A":3,"a":2,"aa":4,"b":1}');
  });

  it("orders integer-like keys as strings, not numerically", () => {
    // The edge where plain-object key order differs from JCS: "10" sorts before "2".
    expect(canonicalJson({ "10": "ten", "2": "two", a: true })).toBe('{"10":"ten","2":"two","a":true}');
  });

  it("sorts nested objects and keeps array order", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, list: [{ b: 1, a: 2 }, 3] })).toBe(
      '{"list":[{"a":2,"b":1},3],"z":{"x":2,"y":1}}',
    );
  });

  it("serializes numbers the way JSON.stringify does", () => {
    for (const value of [0, -0, 1, -1.5, 0.1, 1e21, 1e-7, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE]) {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
    expect(canonicalJson({ n: NaN })).toBe('{"n":null}');
    expect(canonicalJson({ n: Infinity })).toBe('{"n":null}');
  });

  it("serializes strings the way JSON.stringify does", () => {
    const samples = ["plain", 'quote"back\\slash', "tab\tnewline\n", "emoji 😀", "über", "", "𐀀"];
    for (const sample of samples) {
      expect(canonicalJson(sample)).toBe(JSON.stringify(sample));
      expect(canonicalJson({ k: sample })).toBe(`{"k":${JSON.stringify(sample)}}`);
    }
  });

  it("orders keys above the BMP by UTF-16 surrogate code units", () => {
    // BMP characters compare by code point; non-BMP keys by UTF-16 surrogate pair.
    const value = { "￿": 3, 𐀀: 1, "１": 2 };
    expect(canonicalJson(value)).toBe('{"𐀀":1,"１":2,"￿":3}');
    expect(canonicalJson(value)).not.toBe(JSON.stringify(value));
  });

  it("drops undefined and function values like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: () => 1, c: 1 })).toBe('{"c":1}');
    expect(canonicalJson([undefined, () => 1, 2])).toBe("[null,null,2]");
  });

  it("serializes a bare undefined top level as null", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("treats non-plain objects as plain key sets", () => {
    expect(canonicalJson({ d: new Date(0) })).toBe('{"d":{}}');
  });

  it("throws a depth error past the bound", () => {
    const nested = (depth: number): unknown => (depth === 0 ? "leaf" : { next: nested(depth - 1) });
    expect(() => canonicalJson(nested(100))).not.toThrow();
    expect(() => canonicalJson(nested(101))).toThrow(JsonCanonicalDepthError);
    expect(() => canonicalJson(nested(3), 2)).toThrow(JsonCanonicalDepthError);
  });

  it("matches the previous idempotency fingerprint on existing inputs", () => {
    // The retired canonicalize() rebuilt sorted-key plain objects then let
    // JSON.stringify emit them. For non-integer-like keys the byte output is
    // identical (integer-like keys now order by UTF-16 code units per JCS).
    const legacyCanonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(legacyCanonicalize);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => [key, legacyCanonicalize(entry)]),
        );
      }
      return value;
    };
    const inputs: unknown[] = [
      {},
      { b: 1, a: "x" },
      { deep: { z: [1, { q: true }], a: null }, list: [3, 2, 1] },
      { unicode: "héllo 😀", escapes: "a\nb" },
      { mixed: [undefined, { f: () => 1 }, "ok"] },
      { numbers: [-0, 1e21, 0.5, 42] },
      "scalar",
      42,
      true,
      null,
      [1, "two", { three: 3 }],
    ];
    for (const input of inputs) {
      expect(canonicalJson(input), JSON.stringify(input)).toBe(JSON.stringify(legacyCanonicalize(input)));
    }
  });
});
