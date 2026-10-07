/**
 * RFC 8785 (JSON Canonicalization Scheme) subset: the deterministic JSON
 * serialization receipts sign and idempotency fingerprints hash. Object keys
 * sort by UTF-16 code unit — the same order `<` gives on JS strings — and
 * numbers, strings and booleans serialize exactly as `JSON.stringify` emits
 * them, so a value serialized here can be re-serialized by any JCS or
 * JSON.stringify-compatible implementation to the same bytes.
 *
 * Undefined, function and symbol values follow `JSON.stringify` placement
 * rules: dropped from objects, `null` inside arrays. A top-level
 * non-representable value serializes as `null`; BigInt throws the same
 * TypeError `JSON.stringify` raises.
 */

/** Default bound on nested arrays/objects the serializer descends into. */
export const canonicalJsonMaxDepth = 100;

/** Raised when a value nests deeper than the caller's allowed depth. */
export class JsonCanonicalDepthError extends Error {
  constructor(maxDepth: number) {
    super(`Value must not exceed an object/array nesting depth of ${maxDepth} levels.`);
    this.name = "JsonCanonicalDepthError";
  }
}

/**
 * Serialize `value` in canonical form. The top-level value counts as depth 1;
 * containers nested past `maxDepth` raise {@link JsonCanonicalDepthError}.
 */
export function canonicalJson(value: unknown, maxDepth: number = canonicalJsonMaxDepth): string {
  return serializeValue(value, 1, maxDepth) ?? "null";
}

function serializeValue(value: unknown, depth: number, maxDepth: number): string | undefined {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (depth > maxDepth) {
    throw new JsonCanonicalDepthError(maxDepth);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeValue(entry, depth + 1, maxDepth) ?? "null").join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([key, entry]) => {
      const serialized = serializeValue(entry, depth + 1, maxDepth);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
  return `{${entries.join(",")}}`;
}
