// Media branch paths and URLs (design.md §8.3, §8.6; review M16; plan D19). Files live on the orphan
// `media` branch, checked out as the worktree .media/: `media/<draftId>/<file>` plus a root index.json
// ({ "<draftId>": [files…], "sample-<handle>": { sample: true, … } }). Instagram fetches rawUrl
// (raw.githubusercontent.com, available the moment the push lands); pagesUrl is the Pages fallback.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INDEX_FILE = "index.json";

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,119}$/;

// mediaPaths('rp-2026-10-14-kundali-free') → { dir: 'media/rp-…/', rel(file) → 'media/rp-…/<file>' }
export function mediaPaths(draftId) {
  if (!ID_RE.test(String(draftId))) throw new TypeError(`media: bad draft id ${JSON.stringify(draftId)}`);
  const dir = `media/${draftId}/`;
  return { dir, rel: (file) => `${dir}${file}` };
}

function trimSlashes(s) {
  return String(s).replace(/^\/+/, "").replace(/\/+$/, "");
}

// https://raw.githubusercontent.com/<owner>/<repo>/<mediaBranch>/<relPath>
export function rawUrl(config, relPath) {
  const { owner, name, mediaBranch } = config.repo;
  return `https://raw.githubusercontent.com/${owner}/${name}/${mediaBranch}/${trimSlashes(relPath)}`;
}

// <site.url>/<relPath>  (src/build.js copies .media/media/** to dist/media/**, §8.6)
export function pagesUrl(config, relPath) {
  return `${String(config.site.url).replace(/\/+$/, "")}/${trimSlashes(relPath)}`;
}

export function readIndex(mediaRoot) {
  const path = join(mediaRoot, INDEX_FILE);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const value = text.trim() ? JSON.parse(text) : {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`media: ${path} is not an object`);
  return value;
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// updateIndex(mediaRoot, draftId, files, { sample, page, format, at }) → the whole index after the write.
//   A draft entry is the plain file list (design §8.6); a sample entry (plan D19) is an object with
//   sample:true so the site builder can skip it. Entries are kept sorted by key.
export function updateIndex(mediaRoot, draftId, files, { sample = false, page, format, at } = {}) {
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !f)) throw new TypeError("media: files must be a list of file names");
  mkdirSync(mediaRoot, { recursive: true });
  const index = readIndex(mediaRoot);
  if (sample) {
    const entry = { sample: true, files: [...files] };
    if (page) entry.page = page;
    if (format) entry.format = format;
    if (at) entry.at = at;
    index[draftId] = entry;
  } else index[draftId] = [...files];
  const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
  writeAtomic(join(mediaRoot, INDEX_FILE), JSON.stringify(sorted, null, 2) + "\n");
  return sorted;
}

// Files an index entry lists, whichever shape it has (a draft's plain list, a sample object, or a retired entry).
export function indexFiles(entry) {
  if (Array.isArray(entry)) return [...entry];
  if (entry && typeof entry === "object" && Array.isArray(entry.files)) return [...entry.files];
  return [];
}

// retireFiles(mediaRoot, draftId, files, { at }) → the whole index after the write (design §8.6 retention,
// FEAT-202). Deletes media/<draftId>/<file> for each name and turns the draft's index entry into
//   { files: [what remains, e.g. the poster], removed: [{ file, removedAt }, …] }
// so the entry survives (the Published page keeps its poster; the record says what left and when).
// A sample entry keeps its sample:true/page/format/at fields. Returns the index; `removed` lists what was deleted.
export function retireFiles(mediaRoot, draftId, files, { at } = {}) {
  if (!ID_RE.test(String(draftId))) throw new TypeError(`media: bad draft id ${JSON.stringify(draftId)}`);
  if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== "string" || !f || f.includes("/") || f.includes("\\"))) throw new TypeError("media: files must be a non-empty list of file names");
  if (typeof at !== "string" || !at) throw new TypeError("media: retireFiles needs an ISO `at`");
  const index = readIndex(mediaRoot);
  const entry = index[draftId];
  const before = indexFiles(entry);
  const removed = [];
  for (const file of files) {
    const path = join(mediaRoot, "media", draftId, file);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      removed.push(file);
    } else if (before.includes(file)) removed.push(file); // indexed but already gone from disk: drop it from the list too
  }
  const next = entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : {};
  next.files = before.filter((f) => !removed.includes(f));
  next.removed = [...(Array.isArray(next.removed) ? next.removed : []), ...removed.map((file) => ({ file, removedAt: at }))];
  index[draftId] = next;
  const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
  mkdirSync(mediaRoot, { recursive: true });
  writeAtomic(join(mediaRoot, INDEX_FILE), JSON.stringify(sorted, null, 2) + "\n");
  return { index: sorted, removed };
}

// True when .media/ is a git worktree of the media branch (M16: the engine never creates it).
export function mediaBranchPresent(mediaRoot) {
  return existsSync(join(mediaRoot, ".git"));
}
