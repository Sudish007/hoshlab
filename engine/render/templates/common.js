// Shared in-page helpers for every artwork template (plain browser script, loaded from file://).
// The renderer (engine/render/render.js) injects window.__DRAFT__, window.__BRAND__, window.__TOKENS__
// and, for carousels, window.__SLIDE__ before the page loads; each template builds its DOM with the
// helpers below and exposes window.layout() — the in-page measurement the render guards rely on
// (design.md §10; review M8 per-script font rule, M13 text floor + contrast).
(function () {
  "use strict";
  const DEVANAGARI = /[\u0900-\u097F\uA8E0-\uA8FF]/;

  // Headline tiers (design §5 Designer row): A ≤ 36 chars → 104 u, B ≤ 60 → 84 u, C longer → 68 u.
  function pickVariant(text) {
    const n = Array.from(String(text || "")).length;
    return n <= 36 ? "A" : n <= 60 ? "B" : "C";
  }

  // Splits text into runs by script: whitespace sticks to the run before it. [{ mode: 'hi'|'lat', text }]
  function splitRuns(text) {
    const tokens = String(text == null ? "" : text).split(/(\s+)/).filter(Boolean);
    const runs = [];
    for (const t of tokens) {
      const ws = /^\s+$/.test(t);
      const mode = ws ? null : DEVANAGARI.test(t) ? "hi" : "lat";
      const last = runs[runs.length - 1];
      if (last && (mode === null || last.mode === mode)) last.text += t;
      else runs.push({ mode: mode || "lat", text: t });
    }
    return runs;
  }

  // Fills `el` with `text`; Devanagari runs are wrapped in <span lang="hi"> (brand Devanagari family).
  function setText(el, text) {
    el.textContent = "";
    for (const run of splitRuns(text)) {
      if (run.mode === "hi") {
        const span = document.createElement("span");
        span.lang = "hi";
        span.textContent = run.text;
        el.appendChild(span);
      } else el.appendChild(document.createTextNode(run.text));
    }
    return el;
  }

  // Applies the brand tokens as CSS custom properties on #canvas.
  function applyTokens(canvas, tokens) {
    const vars = (tokens && tokens.vars) || {};
    for (const name of Object.keys(vars)) canvas.style.setProperty(name, vars[name]);
  }

  // Appends an <li> per fact (≤ 3 shown; the Writer caps them at 3 anyway).
  function fillList(ul, items, decorate) {
    ul.textContent = "";
    (items || []).forEach((item, i) => {
      const li = document.createElement("li");
      if (decorate) decorate(li, i);
      const span = document.createElement("span");
      setText(span, item);
      li.appendChild(span);
      ul.appendChild(li);
    });
    return ul;
  }

  function fillDots(el, count, on) {
    el.textContent = "";
    for (let i = 0; i < count; i++) {
      const dot = document.createElement("i");
      if (i === on) dot.className = "on";
      el.appendChild(dot);
    }
  }

  // Host of the brand site for footers ('rishtapatra.com').
  function siteHost(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return String(url || "");
    }
  }

  // ---------------------------------------------------------------------------------------
  // Measurement

  function parseColor(str) {
    const s = String(str || "").trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) {
      let a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (m[4] && m[4].endsWith("%")) a /= 100;
      return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a: a };
    }
    if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    return { r: 0, g: 0, b: 0, a: 1 };
  }

  function channel(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  // WCAG 2 relative luminance and contrast ratio.
  function luminance(c) {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function composite(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  function hex(c) {
    const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  // The painted background behind `el`: the nearest ancestor with data-bg (solid approximation of a
  // gradient) or an opaque background-color; semi-transparent layers are composited on the way out.
  function backgroundOf(el) {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.dataset && node.dataset.bg) {
        layers.push(parseColor(node.dataset.bg));
        break;
      }
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      node = node.parentElement;
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) result = composite(layers[i], result);
    return result;
  }

  function firstFamily(fontFamily) {
    const first = String(fontFamily || "").split(",")[0].trim();
    return first.replace(/^["']|["']$/g, "").trim();
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function describe(el) {
    const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
  }

  // Every element whose content does not fit its box. Horizontal: any block whose scrollWidth exceeds
  // its clientWidth (an unbreakable word pokes out). Vertical: only clipping boxes (overflow-y not
  // visible — #canvas is one), because an auto-height block grows with its lines and only its inline
  // boxes' ascent/descent can exceed a tight line-height, which clips nothing; real vertical overflow
  // always surfaces at the clipping canvas.
  function overflowing(canvas) {
    const out = [];
    const els = [canvas].concat(Array.from(canvas.querySelectorAll("*")));
    for (const el of els) {
      if (el !== canvas && el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents" || cs.display === "none") continue;
      if (el.clientHeight === 0 && el.clientWidth === 0) continue;
      const clips = cs.overflowY !== "visible";
      const dy = clips ? el.scrollHeight - el.clientHeight : 0;
      const dx = el.scrollWidth - el.clientWidth;
      if (dy > 1 || dx > 1) {
        out.push({ element: describe(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) });
      }
    }
    return out;
  }

  // Every rendered text run with its computed first font-family, size in u, colours and contrast.
  function textRuns(canvas) {
    const scale = canvas.clientWidth / 1080 || 1;
    const walker = document.createTreeWalker(canvas, NodeFilter.SHOW_TEXT);
    const runs = [];
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest("svg")) continue;
      // a [hidden] ancestor hides the run without changing the span's own computed display
      if (typeof el.checkVisibility === "function" ? !el.checkVisibility() : el.getClientRects().length === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      let text = raw;
      if (cs.textTransform === "uppercase") text = text.toUpperCase();
      else if (cs.textTransform === "lowercase") text = text.toLowerCase();
      const bg = backgroundOf(el);
      const color = parseColor(cs.color);
      const fg = color.a < 1 ? composite(color, bg) : color;
      const langEl = el.closest("[lang]");
      runs.push({
        text: text,
        family: firstFamily(cs.fontFamily),
        weight: cs.fontWeight,
        sizeU: round2(parseFloat(cs.fontSize) / scale),
        color: hex(fg),
        bg: hex(bg),
        contrast: round2(contrastRatio(fg, bg)),
        lang: langEl ? langEl.getAttribute("lang") : "",
        element: describe(el),
      });
    }
    return runs;
  }

  // window.layout() → { variant, overflow, overflows[], runs[], minTextU, minContrast, canvas }
  function layout() {
    const canvas = document.getElementById("canvas");
    const overflows = overflowing(canvas);
    const runs = textRuns(canvas);
    const headline = canvas.querySelector(".headline");
    return {
      variant: headline ? headline.getAttribute("data-variant") : null,
      palette: canvas.getAttribute("data-palette") || null,
      overflow: overflows.length > 0,
      overflows: overflows,
      runs: runs,
      minTextU: runs.length ? Math.min.apply(null, runs.map((r) => r.sizeU)) : null,
      minContrast: runs.length ? Math.min.apply(null, runs.map((r) => r.contrast)) : null,
      canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
    };
  }

  window.HOSHLAB = { pickVariant, splitRuns, setText, applyTokens, fillList, fillDots, siteHost, parseColor, luminance, contrastRatio, backgroundOf, layout };
  window.layout = layout;
})();
