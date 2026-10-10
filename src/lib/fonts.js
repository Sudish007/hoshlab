// Exact font files copied into dist/fonts/ (design §14: Inter UI + Noto Sans Devanagari for Devanagari
// runs; latin + devanagari subsets only). Shared by build.js (copy + budget) and layout.js (preloads).
export const FONT_FILES = [
  ["@fontsource/inter", "inter-latin-400-normal.woff2"],
  ["@fontsource/inter", "inter-latin-500-normal.woff2"],
  ["@fontsource/inter", "inter-latin-600-normal.woff2"],
  ["@fontsource/inter", "inter-latin-700-normal.woff2"],
  ["@fontsource/noto-sans-devanagari", "noto-sans-devanagari-devanagari-400-normal.woff2"],
  ["@fontsource/noto-sans-devanagari", "noto-sans-devanagari-devanagari-700-normal.woff2"],
  ["@fontsource/noto-sans-devanagari", "noto-sans-devanagari-latin-400-normal.woff2"],
  ["@fontsource/noto-sans-devanagari", "noto-sans-devanagari-latin-700-normal.woff2"],
];

// Sum of every file in dist/fonts/ must stay under this (bytes); the build fails otherwise.
export const FONT_BUDGET = 600 * 1024;

// The files worth a <link rel=preload>: the body face and the heading weight.
export const PRELOAD_FILES = ["inter-latin-400-normal.woff2", "inter-latin-700-normal.woff2"];

// dist-relative paths, e.g. "fonts/inter-latin-400-normal.woff2".
export function fontUrls() {
  return FONT_FILES.map(([, file]) => `fonts/${file}`);
}

export function preloadUrls() {
  return PRELOAD_FILES.map((file) => `fonts/${file}`);
}
