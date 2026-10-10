// Logging that cannot leak secrets (design.md §16): every line goes through scrub() first.

const MASK = "•••";

// Replaces every secret (and its URL-encoded form) with ••• in text.
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join(MASK);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(MASK);
  }
  // Generic token shapes that may appear in error payloads even when the env list is stale.
  out = out.replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, MASK);
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, MASK);
  out = out.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, MASK);
  out = out.replace(/([?&](?:access_token|key|api_key)=)[^&\s"']+/gi, `$1${MASK}`);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${MASK}`);
  return out;
}

export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatUsd(usd) {
  return `$${Number(usd).toFixed(2)}`;
}

// stepLine('writer', true, 9100, 3, 0.04, '6 ideas') → '[writer] ok 9.1s 3 calls $0.04 — 6 ideas'
export function stepLine(agent, ok, ms, calls, costUsd, note) {
  const parts = [`[${agent}]`, ok ? "ok" : "FAIL", formatMs(ms), `${calls} call${calls === 1 ? "" : "s"}`, formatUsd(costUsd)];
  if (note) parts.push("—", note);
  return parts.join(" ");
}

// createLogger({ secrets, stdout, stderr }) → { info, warn, error, step, lines }
// Writes only through scrub(); `lines` keeps the scrubbed history for run records.
export function createLogger({ secrets = [], stdout = (s) => process.stdout.write(s + "\n"), stderr = (s) => process.stderr.write(s + "\n"), prefix = "" } = {}) {
  const lines = [];
  const emit = (sink, level, text) => {
    const line = scrub(`${prefix}${text}`, secrets);
    lines.push({ level, line });
    sink(line);
    return line;
  };
  return {
    lines,
    addSecret(value) {
      if (typeof value === "string" && value.length >= 8) secrets.push(value);
    },
    info: (text) => emit(stdout, "info", text),
    warn: (text) => emit(stderr, "warn", `warn: ${text}`),
    error: (text) => emit(stderr, "error", `error: ${text}`),
    step: (agent, ok, ms, calls, costUsd, note) => emit(stdout, "info", stepLine(agent, ok, ms, calls, costUsd, note)),
    scrub: (text) => scrub(text, secrets),
  };
}
