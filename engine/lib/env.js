// Environment access that never leaks secret values (design.md §12 "Env secrets", §16).
// readEnv() reports presence only; values are fetched on demand through get() and must stay
// in variables — never log, print or commit them.

export const API_KEY_RE = /^\S{20,}$/;
export const IG_TOKEN_RE = /^\S{50,}$/;

export function isTruthy(value) {
  if (value === undefined || value === null) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

// Shape rule for a secret by name: IG tokens need ≥ 50 non-space chars, API keys ≥ 20.
export function validateSecretShape(name, value) {
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: `${name} is not set` };
  const re = /^IG_TOKEN_/.test(name) ? IG_TOKEN_RE : API_KEY_RE;
  if (!re.test(value)) return { ok: false, reason: `${name} does not look like a ${re === IG_TOKEN_RE ? "token (expected ^\\S{50,}$)" : "key (expected ^\\S{20,}$)"}` };
  return { ok: true, reason: null };
}

// readEnv(['ANTHROPIC_API_KEY', …], source = process.env) →
//   { present: { NAME: true|false }, get(name), shape(name) }
// `present` is safe to log; get() returns the raw value for use in a request header only.
export function readEnv(names, source = globalThis.process ? globalThis.process.env : {}) {
  const present = {};
  for (const name of names) present[name] = typeof source[name] === "string" && source[name].length > 0;
  return {
    present,
    get(name) {
      return present[name] ? source[name] : undefined;
    },
    shape(name) {
      return validateSecretShape(name, source[name]);
    },
    // Every secret value that is set, for log scrubbing.
    secrets() {
      return names.filter((n) => present[n]).map((n) => source[n]);
    },
    toJSON() {
      return { present };
    },
  };
}
