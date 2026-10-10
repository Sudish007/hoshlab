// scripts/lib/empty-region.js — the OF-4 rasteriser and maximal empty rectangle, on synthetic input
// (no browser): fully painted → null; a 200 × ~900 px hole at 1920 wide → reported; a 150 px tall hole → null.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { CELL, MIN_HEIGHT_PX, MIN_WIDTH_FRACTION, collectPaintRects, emptyRegion, largestEmptyRectangle, rasterise } from "../scripts/lib/empty-region.js";

const W = 1920;
const H = 1080;

// Paints everything except the hole [x0, x1) × [y0, y1).
function frameAround(x0, y0, x1, y1) {
  return [
    [0, 0, W, y0], // above
    [0, y1, W, H], // below
    [0, 0, x0, H], // left
    [x1, 0, W, H], // right
  ];
}

test("constants match the design rule (8 px grid, 160 px, 40 %)", () => {
  assert.equal(CELL, 8);
  assert.equal(MIN_HEIGHT_PX, 160);
  assert.equal(MIN_WIDTH_FRACTION, 0.4);
});

test("fully painted viewport → null", () => {
  assert.equal(emptyRegion({ width: W, height: H, rects: [[0, 0, W, H]] }), null);
});

test("a 200 px tall × 904 px wide hole at 1920 wide → reported with its box", () => {
  const region = emptyRegion({ width: W, height: H, rects: frameAround(504, 104, 1408, 304) });
  assert.deepEqual(region, { x: 504, y: 104, w: 904, h: 200 });
  assert.ok(region.h > MIN_HEIGHT_PX && region.w > MIN_WIDTH_FRACTION * W);
});

test("a 150 px tall hole spanning the full width → null (not taller than 160 px)", () => {
  assert.equal(emptyRegion({ width: W, height: H, rects: frameAround(0, 104, W, 254) }), null);
});

test("a tall hole narrower than 40 % of the width → null; just over 40 % → reported", () => {
  // 760 px wide (39.6 %) is allowed; 776 px (40.4 %) is not.
  assert.equal(emptyRegion({ width: W, height: H, rects: frameAround(0, 0, 760, 600) }), null);
  assert.deepEqual(emptyRegion({ width: W, height: H, rects: frameAround(0, 0, 776, 600) }), { x: 0, y: 0, w: 776, h: 600 });
});

test("exactly 160 px tall or exactly 40 % wide is allowed (strict thresholds)", () => {
  assert.equal(emptyRegion({ width: W, height: H, rects: frameAround(0, 104, W, 264) }), null);
  assert.equal(emptyRegion({ width: W, height: H, rects: frameAround(0, 0, 768, 600) }), null);
});

test("an empty viewport is one big region; the largest region wins when several qualify", () => {
  assert.deepEqual(emptyRegion({ width: W, height: H, rects: [] }), { x: 0, y: 0, w: W, h: H });
  // Two holes between the same left/right frame: 200 px tall (y 104..304) and 400 px tall (y 320..720);
  // a painted band (y 304..320) separates them.
  const rects = [[0, 0, 504, H], [1408, 0, W, H], [0, 0, W, 104], [0, 304, W, 320], [0, 720, W, H]];
  const region = emptyRegion({ width: W, height: H, rects });
  assert.deepEqual(region, { x: 504, y: 320, w: 904, h: 400 });
});

test("short pages: scanHeight stops the scan at the end of <main>, so the footer gap is not a defect", () => {
  const rects = [[0, 0, W, 300]]; // content ends at 300 px; nothing below until a footer off the scan
  assert.deepEqual(emptyRegion({ width: W, height: H, rects }), { x: 0, y: 304, w: W, h: 776 });
  assert.equal(emptyRegion({ width: W, height: H, rects, scanHeight: 300 }), null);
});

test("rasterise marks every cell a rectangle touches; largestEmptyRectangle works on a synthetic grid", () => {
  const grid = rasterise([[3, 3, 9, 9]], { width: 32, height: 16, cell: 8 });
  assert.equal(grid.cols, 4);
  assert.equal(grid.rows, 2);
  assert.deepEqual([...grid.cells], [1, 1, 0, 0, 1, 1, 0, 0]);
  // A 2 × 2 empty block in cells → 16 × 16 px with thresholds 0; none when minH requires > 2 cells.
  assert.deepEqual(largestEmptyRectangle(grid), { x: 16, y: 0, w: 16, h: 16 });
  assert.equal(largestEmptyRectangle(grid, { minH: 2 }), null);
  assert.equal(largestEmptyRectangle(grid, { scanRows: 0 }), null);
});

test("2560 × 1440 at the same rule: the 40 % threshold scales with the width", () => {
  // 1024 px is exactly 40 % of 2560 → allowed; 1032 px → reported.
  assert.equal(emptyRegion({ width: 2560, height: 1440, rects: [[0, 0, 2560, 100], [0, 400, 2560, 1440], [1024, 0, 2560, 1440]] }), null);
  assert.deepEqual(emptyRegion({ width: 2560, height: 1440, rects: [[0, 0, 2560, 100], [0, 400, 2560, 1440], [1032, 0, 2560, 1440]] }), { x: 0, y: 104, w: 1032, h: 296 });
});

test("collectPaintRects is self-contained (no imports, no closure) so page.evaluate can serialise it", () => {
  const src = collectPaintRects.toString();
  assert.match(src, /^function collectPaintRects\(\)/);
  for (const name of ["CELL", "MIN_HEIGHT_PX", "MIN_WIDTH_FRACTION", "rasterise", "emptyRegion", "largestEmptyRectangle"]) assert.ok(!src.includes(name), `${name} referenced inside collectPaintRects`);
});
