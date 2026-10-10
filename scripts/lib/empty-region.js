// OF-4 empty-region rule (design §0 OF-4, review M11): at 1920×1080 and 2560×1440, above the fold, there is
// no empty rectangle taller than 160 px spanning more than 40 % of the viewport width. "Painted" = text,
// img/svg/video/canvas/hr, filled backgrounds and border strokes, rasterised on an 8 px grid; the largest
// all-empty rectangle is found with the histogram/stack maximal-rectangle algorithm (port of mock/shoot.py).
//
// Two halves, so the rule is unit-testable without a browser (tests/audit-script.test.js):
//   collectPaintRects()  runs INSIDE the page (pass it to page.evaluate; it is self-contained — no closure,
//                        no imports) and returns { width, height, scanHeight, rects: [[l, t, r, b], …] }.
//   emptyRegion(...)     runs in Node on that payload (or on synthetic rects/grids) and returns
//                        null or { x, y, w, h } in CSS px.
// No node: imports — the file stays browser-safe.

export const CELL = 8;
export const MIN_HEIGHT_PX = 160;
export const MIN_WIDTH_FRACTION = 0.4;

// Paint rectangles of everything visible in the viewport, in CSS px. Short pages (document no taller than
// the viewport) are measured only to the end of <main>'s content: the flex-pushed footer gap is not a
// layout defect, so scanHeight stops at the lowest bottom edge among <main>'s children.
export function collectPaintRects() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rects = [];
  const push = (left, top, right, bottom) => {
    if (bottom <= 0 || top >= H || right <= 0 || left >= W || right <= left || bottom <= top) return;
    rects.push([left, top, right, bottom]);
  };
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const isBg = (c) => c === bodyBg || c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 3) {
      if (!node.textContent.trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) push(r.left, r.top, r.right, r.bottom);
      continue;
    }
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= H) continue;
    if (/^(IMG|SVG|VIDEO|CANVAS|HR)$/i.test(node.tagName)) {
      push(r.left, r.top, r.right, r.bottom);
      continue;
    }
    const filled = !isBg(cs.backgroundColor) || (cs.backgroundImage && cs.backgroundImage !== "none");
    if (filled) {
      push(r.left, r.top, r.right, r.bottom);
      continue;
    }
    const bordered = ["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs["border" + s + "Width"]) > 0 && cs["border" + s + "Style"] !== "none");
    if (bordered) {
      push(r.left, r.top, r.right, r.top + 1);
      push(r.left, r.bottom - 1, r.right, r.bottom);
      push(r.left, r.top, r.left + 1, r.bottom);
      push(r.right - 1, r.top, r.right, r.bottom);
    }
  }
  let scanHeight = H;
  const mainEl = document.querySelector("main");
  const footEl = document.querySelector("footer");
  if (mainEl && footEl) {
    const mainBottom = Math.max(0, ...[...mainEl.children].map((c) => c.getBoundingClientRect().bottom));
    const footTop = footEl.getBoundingClientRect().top;
    if (document.documentElement.scrollHeight <= H + 1 && footTop - mainBottom > 24) scanHeight = Math.min(H, mainBottom);
  }
  return { width: W, height: H, scanHeight, rects };
}

// Rasterises paint rectangles onto a cell grid: a cell is painted when any rectangle touches it.
export function rasterise(rects, { width, height, cell = CELL }) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = new Uint8Array(cols * rows);
  for (const [left, top, right, bottom] of rects) {
    if (right <= left || bottom <= top) continue;
    const x0 = Math.max(0, Math.floor(left / cell));
    const x1 = Math.min(cols - 1, Math.floor((right - 1) / cell));
    const y0 = Math.max(0, Math.floor(top / cell));
    const y1 = Math.min(rows - 1, Math.floor((bottom - 1) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells[y * cols + x] = 1;
  }
  return { cols, rows, cell, cells };
}

// Largest all-empty rectangle (by area) within the first scanRows rows whose size exceeds the thresholds
// (minW/minH in cells, strict: the design says "taller than 160 px" and "more than 40 %"). Returns null or
// { x, y, w, h } in px.
export function largestEmptyRectangle({ cols, rows, cell, cells }, { scanRows = rows, minW = 0, minH = 0 } = {}) {
  let worst = null;
  let worstArea = 0; // in cells (shoot.py compared cells against px here and kept the first hit; fixed)
  const hist = new Int32Array(cols);
  const limit = Math.min(rows, scanRows);
  for (let y = 0; y < limit; y++) {
    for (let x = 0; x < cols; x++) hist[x] = cells[y * cols + x] ? 0 : hist[x] + 1;
    const stack = [];
    for (let x = 0; x <= cols; x++) {
      const h = x === cols ? 0 : hist[x];
      let start = x;
      while (stack.length && stack[stack.length - 1].h > h) {
        const top = stack.pop();
        const w = x - top.start;
        if (top.h > minH && w > minW && top.h * w > worstArea) {
          worstArea = top.h * w;
          worst = { x: top.start * cell, y: (y - top.h + 1) * cell, w: w * cell, h: top.h * cell };
        }
        start = top.start;
      }
      stack.push({ h, start });
    }
  }
  return worst;
}

// The rule itself: null when the viewport (to scanHeight) holds no empty rectangle taller than
// minHeightPx and wider than minWidthFraction × width, otherwise the largest such rectangle.
export function emptyRegion({ width, height, rects, scanHeight = height, cell = CELL, minHeightPx = MIN_HEIGHT_PX, minWidthFraction = MIN_WIDTH_FRACTION }) {
  const grid = rasterise(rects, { width, height, cell });
  return largestEmptyRectangle(grid, {
    scanRows: Math.ceil(Math.min(height, scanHeight) / cell),
    minW: Math.floor((minWidthFraction * width) / cell),
    minH: Math.floor(minHeightPx / cell),
  });
}
