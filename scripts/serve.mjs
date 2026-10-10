// Tiny static server that mounts dist/ under basePath, exactly as GitHub Pages will
// (including gzip for text assets, so local Lighthouse sees production transfer sizes).
// Usage: npm run serve  (PORT env var optional, default 4173)
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import config from "../site.config.js";

const DIST = join(fileURLToPath(new URL("../dist/", import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const BASE = config.basePath;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg", ".xml", ".txt", ".json"]);

function send(req, res, status, file) {
  const ext = extname(file);
  const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "max-age=600" };
  if (gzip) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(status, headers);
    createReadStream(file).pipe(createGzip()).pipe(res);
  } else {
    headers["Content-Length"] = statSync(file).size;
    res.writeHead(status, headers);
    createReadStream(file).pipe(res);
  }
}

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/" || pathname === BASE.slice(0, -1)) {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  if (!pathname.startsWith(BASE)) {
    return send(req, res, 404, join(DIST, "404.html"));
  }
  const rel = normalize(pathname.slice(BASE.length)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, rel);
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { Location: pathname + "/" });
      return res.end();
    }
    file = join(file, "index.html");
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    return send(req, res, 404, join(DIST, "404.html"));
  }
  send(req, res, 200, file);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Serving dist/ at http://127.0.0.1:${PORT}${BASE}`);
});
