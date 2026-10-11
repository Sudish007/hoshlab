// Design §14: 12 px text floor (--fs-xs: 0.75rem is the smallest size), 44 px controls, light only, no
// gradients/shadows in chrome, no horizontal scroll containers (OF-8). Static checks on public/styles.css.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ROOT, read } from "./helpers.js";

const css = read(join(ROOT, "public", "styles.css"));
const vars = Object.fromEntries([...css.matchAll(/(--fs-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

// Smallest pixel value a font-size expression can take at a 16 px root (clamp → its minimum).
function minPx(expr) {
  let e = expr.trim();
  const v = /^var\((--[\w-]+)\)$/.exec(e);
  if (v) e = vars[v[1]] ?? assert.fail(`unknown variable ${v[1]}`);
  const c = /^clamp\(\s*([^,]+),/.exec(e);
  if (c) e = c[1].trim();
  const m = /^([\d.]+)(px|rem|em)$/.exec(e);
  assert.ok(m, `unparsed font-size ${expr}`);
  return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
}

test("no font-size below 12 px / 0.75rem anywhere in styles.css (including the --fs-* tokens)", () => {
  assert.equal(vars["--fs-xs"], "0.75rem");
  for (const [name, value] of Object.entries(vars)) assert.ok(minPx(value) >= 12, `${name}: ${value}`);
  const sizes = [...css.matchAll(/font-size:\s*([^;}]+)[;}]/g)].map((m) => m[1].trim());
  assert.ok(sizes.length > 20);
  for (const s of sizes) assert.ok(minPx(s) >= 12, `font-size ${s}`);
  assert.ok(css.includes("font-size: clamp(16px, 15px + 0.2vw, 18px)"), "root font size");
});

test("44 px controls: --control is 44px and applies to buttons, inputs, selects, .btn, nav links and footer links (N11)", () => {
  assert.match(css, /--control:\s*44px/);
  assert.match(css, /button, input, select \{[^}]*min-height: var\(--control\)/);
  assert.match(css, /\.btn, button\.btn \{[^}]*min-height: var\(--control\)/);
  assert.match(css, /\.site-nav a \{[^}]*min-height: var\(--control\)/);
  assert.match(css, /\.footer-inner a \{[^}]*min-height: var\(--control\)/);
  assert.ok(!/min-height:\s*40px/.test(css), "no 40 px control (the mock's segmented buttons)");
});

test("chrome rules: no gradients, no box-shadow except the nav underline, no overflow-x scroll rows beyond the captioned .table-wrap (M12), light only, no max-width cap", () => {
  assert.ok(!/gradient\(/.test(css), "no gradient");
  const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(shadows, ["inset 0 -2px 0 var(--ink)"]);
  // OF-8 forbids scroll rows in the chrome; review M12 allows exactly one horizontal scroller, the captioned
  // .table-wrap the Analyst's report tables sit in (FEAT-203) — the same rule tests/dist-admin.test.js applies to admin.css.
  assert.equal((css.match(/overflow-x:\s*(auto|scroll)/g) || []).length, 1, "the captioned .table-wrap is the only horizontal scroller (OF-8, M12)");
  assert.match(css, /\.table-wrap \{[^}]*overflow-x: auto/);
  assert.ok(!/\.site-nav[^{]*\{[^}]*overflow-x/.test(css), "the nav never scrolls (OF-8)");
  assert.ok(!/overflow:\s*(auto|scroll)/.test(css), "no scroll container");
  assert.ok(!/prefers-color-scheme/.test(css), "light theme only");
  assert.match(css, /color-scheme: light/);
  assert.match(css, /\.container \{ width: calc\(100% - 2 \* var\(--gutter\)\); margin-inline: auto; \}/);
  for (const m of css.matchAll(/max-width:\s*([\d.]+)(px|rem|ch)/g)) {
    const px = m[2] === "px" ? Number(m[1]) : m[2] === "rem" ? Number(m[1]) * 18 : Number(m[1]) * 18 * 0.6;
    assert.ok(px < 1200, `${m[0]} is a content cap, not a container cap`);
  }
  assert.ok(!/\.mock-banner|\.post-rp|\.post-kd|\.post-jr|\.admin-tabs|\.queue-item|\.mode-row/.test(css), "mock-only and admin-only rules are not in styles.css");
  assert.match(css, /\.site-nav ul \{[^}]*flex-wrap: wrap/, "nav wraps (OF-8)");
  assert.match(css, /__BASE__fonts\/inter-latin-400-normal\.woff2/, "font URLs use the __BASE__ token");
});
