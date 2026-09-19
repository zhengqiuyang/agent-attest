/**
 * Deterministic JSON canonicalization: object keys are recursively sorted,
 * insignificant whitespace removed, `undefined` object values dropped.
 * The canonical form is what gets hashed and signed, so every consumer
 * computing it independently agrees byte-for-byte.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(encode).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(",") + "}";
}
