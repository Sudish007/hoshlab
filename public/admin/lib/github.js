// Minimal GitHub REST client for the admin (contents + actions endpoints). fetch is injectable so
// node:test can drive it. The token lives only in the Authorization header of api.github.com requests:
// it is never part of a URL, an Error, a log line or a raw.githubusercontent.com request (review N6 —
// thumbnails are plain <img> loads built by rawUrl()). (ai-batkahi pattern, English messages, plus
// dispatchWorkflow / latestWorkflowRun for "Run now" — design §13.)
import { encodeUtf8, encodeBytes, decodeUtf8 } from "./base64.js";

const API_VERSION = "2022-11-28";
export const RAW_HOST = "https://raw.githubusercontent.com";

export class GitHubError extends Error {
  constructor(status, message, { rateLimitReset = null, kind = "http" } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.rateLimitReset = rateLimitReset;
    this.kind = kind;
  }
  userMessage() {
    if (this.kind === "network") return "No network — try again";
    if (this.kind === "push") return "Token has no write access to this repository";
    if (this.status === 401) return "Token invalid or expired";
    if (this.status === 403 && this.rateLimitReset) {
      const time = new Date(this.rateLimitReset * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
      return `GitHub rate limit — try again at ${time} IST`;
    }
    if (this.status === 403 || this.status === 404) return "Token lacks access to this repository";
    if (this.status === 409) return "This file changed in the meantime";
    if (this.status === 422) return this.message;
    return `GitHub ${this.status}: ${this.message}`;
  }
}

// Replace every occurrence of the token in free text (activity log, console).
export function scrub(text, token) {
  const s = String(text);
  return token ? s.split(token).join("•••") : s;
}

export function createClient({ token, owner, repo, branch, fetchImpl = globalThis.fetch.bind(globalThis), api = "https://api.github.com" }) {
  const base = `/repos/${owner}/${repo}`;

  async function request(method, path, body) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      Authorization: `Bearer ${token}`,
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchImpl(api + path, init);
    } catch (err) {
      if (err instanceof TypeError) throw new GitHubError(0, "network", { kind: "network" });
      throw err;
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = remaining === "0" ? Number(res.headers.get("x-ratelimit-reset")) : null;
      throw new GitHubError(res.status, json.message || res.statusText, { rateLimitReset: reset });
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const contents = (path) => `${base}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  return {
    owner,
    repo,
    branch,
    // GET /repos/{o}/{r} — the token check reads permissions.push (design §12).
    repoInfo: () => request("GET", base),
    async listDir(path) {
      try {
        const json = await request("GET", contents(path));
        return Array.isArray(json) ? json : [];
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return [];
        throw err;
      }
    },
    async getFile(path) {
      const json = await request("GET", contents(path));
      return { text: decodeUtf8(json.content), sha: json.sha, bytesBase64: json.content };
    },
    async putFile(path, { content, message, sha }) {
      const encoded = typeof content === "string" ? encodeUtf8(content) : encodeBytes(content);
      const json = await request("PUT", `${base}/contents/${path}`, {
        message,
        content: encoded,
        branch,
        ...(sha ? { sha } : {}),
      });
      return { contentSha: json.content.sha, commitSha: json.commit.sha };
    },
    // POST /repos/{o}/{r}/actions/workflows/<file>/dispatches { ref, inputs } → 204. Input values are sent
    // as strings: the dispatch endpoint validates boolean inputs against 'true'/'false' like `gh workflow run -f`.
    async dispatchWorkflow(file, inputs = {}) {
      const strInputs = {};
      for (const [k, v] of Object.entries(inputs)) strInputs[k] = typeof v === "string" ? v : JSON.stringify(v);
      await request("POST", `${base}/actions/workflows/${encodeURIComponent(file)}/dispatches`, { ref: branch, inputs: strInputs });
      return { dispatchedAt: new Date().toISOString() };
    },
    async latestWorkflowRun(file) {
      const json = await request("GET", `${base}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=1`);
      return (json && json.workflow_runs && json.workflow_runs[0]) || null;
    },
    run: (id) => request("GET", `${base}/actions/runs/${id}`),
    // raw.githubusercontent.com URL for <img> thumbnails — fetched by the browser WITHOUT the token (N6).
    rawUrl: (path, ref = branch) => `${RAW_HOST}/${owner}/${repo}/${ref}/${String(path).replace(/^\/+/, "")}`,
  };
}
