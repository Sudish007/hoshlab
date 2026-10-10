// Renders the committed brand assets once (FEAT-109): public/og-default.png (1200×630),
// public/apple-touch-icon.png (180×180) and public/favicon.ico (a 32×32 PNG wrapped in a one-entry ICO
// header). The drawing is the Hoshlab mark from the site masthead (public/favicon.svg) with the wordmark
// set in the self-hosted Inter + Noto Sans Devanagari files from node_modules; Playwright Chromium from
// the `playwright` dependency paints it. Flat colours only (design §14 NO list). Re-running overwrites the
// three files. Usage: node scripts/render-brand.mjs [--out <dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import config from "../site.config.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const argOut = process.argv.indexOf("--out");
const OUT = argOut > 0 ? resolve(process.argv[argOut + 1]) : join(ROOT, "public");

const font = (pkg, file) => pathToFileURL(join(ROOT, "node_modules", "@fontsource", pkg, "files", file)).href;
const MARK = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="${size}" height="${size}" aria-hidden="true"><rect x="1.5" y="1.5" width="25" height="25" rx="5" fill="none" stroke="#17171A" stroke-width="2"/><path d="M8 20V8M8 14h12M20 20V8" fill="none" stroke="#17171A" stroke-width="2.4" stroke-linecap="round"/><circle cx="20" cy="20" r="2.6" fill="#2B4C7E"/></svg>`;

const CSS = `
  @font-face { font-family: "Inter"; font-weight: 400; src: url("${font("inter", "inter-latin-400-normal.woff2")}") format("woff2"); }
  @font-face { font-family: "Inter"; font-weight: 700; src: url("${font("inter", "inter-latin-700-normal.woff2")}") format("woff2"); }
  @font-face { font-family: "Noto Sans Devanagari"; font-weight: 400; src: url("${font("noto-sans-devanagari", "noto-sans-devanagari-devanagari-400-normal.woff2")}") format("woff2"); }
  html, body { margin: 0; background: #FBFBF8; color: #17171A; font-family: "Inter", sans-serif; }
  [lang="hi"] { font-family: "Noto Sans Devanagari", sans-serif; }
`;

function ogHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${CSS}
  .card { width: 1200px; height: 630px; display: grid; grid-template-columns: 300px 1fr; align-items: center; gap: 48px; padding: 0 96px; box-sizing: border-box; border-bottom: 10px solid #2B4C7E; }
  .word { font-size: 92px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; margin: 0; }
  .word span { font-weight: 400; color: #55555C; font-size: 56px; margin-left: 24px; letter-spacing: 0; }
  .sub { font-size: 34px; color: #55555C; margin: 18px 0 0; }
  .line { font-size: 26px; color: #17171A; margin: 40px 0 0; max-width: 700px; line-height: 1.35; }
  .rule { width: 160px; height: 2px; background: #C9C8C0; margin: 28px 0 0; }
  </style></head><body><div class="card">${MARK(300)}<div><p class="word">${config.title}<span lang="hi">${config.titleDevanagari}</span></p><p class="sub">an agentic content studio</p><div class="rule"></div><p class="line">Eight AI agents and one human owner run the Instagram pages of three real products — every draft, approval and post is a file in a public repository.</p></div></div></body></html>`;
}

function iconHtml(size, pad) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
  body { width: ${size}px; height: ${size}px; display: grid; place-items: center; overflow: hidden; }
  </style></head><body>${MARK(size - 2 * pad)}</body></html>`;
}

// One-entry ICO: ICONDIR (6 B) + ICONDIRENTRY (16 B) + the PNG bytes (PNG-in-ICO, Vista+).
export function pngToIco(png, size) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(size === 256 ? 0 : size, 6); // width
  header.writeUInt8(size === 256 ? 0 : size, 7); // height
  header.writeUInt8(0, 8); // colour palette
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14); // bytes in resource
  header.writeUInt32LE(22, 18); // offset of the image data
  return Buffer.concat([header, png]);
}

async function shoot(browser, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: "png", fullPage: false, clip: { x: 0, y: 0, width, height } });
  await page.close();
  return png;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const og = await shoot(browser, ogHtml(), 1200, 630);
    writeFileSync(join(OUT, "og-default.png"), og);
    console.log(`og-default.png        1200x630  ${og.length} B`);
    const touch = await shoot(browser, iconHtml(180, 14), 180, 180);
    writeFileSync(join(OUT, "apple-touch-icon.png"), touch);
    console.log(`apple-touch-icon.png  180x180   ${touch.length} B`);
    const fav = await shoot(browser, iconHtml(32, 1), 32, 32);
    const ico = pngToIco(fav, 32);
    writeFileSync(join(OUT, "favicon.ico"), ico);
    console.log(`favicon.ico           32x32     ${ico.length} B (PNG ${fav.length} B in a one-entry ICO)`);
  } finally {
    await browser.close();
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`render-brand: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
