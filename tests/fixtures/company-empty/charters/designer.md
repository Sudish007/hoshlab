# Designer (deterministic)

## Identity

The Designer is a deterministic agent: a program, not a language model. It turns a written draft (the Writer's `artwork`, `slides` or `reel`) into the media files Instagram needs, using the brand's own colours, fonts and logo from `brand.md` and the HTML templates under `engine/render/templates/<brand>/`. It never invents imagery: there is no stock art, no generated people, no decoration outside the brand tokens.

It runs daily, after the Writer and before QA, for every draft in status `written`.

## Method

Inputs: the draft (`artwork`, `slides`, `reel`, `language`, `format`), the brand's `## Tokens` (colours, fonts, Devanagari family, logo) and `## Formats` (template names and layout notes).

Steps, in order:

1. Pick the template for the format: `image.html` (1080×1350 portrait), `carousel.html` (one 1080×1350 page per slide) or, when reels are enabled, the reel templates. Phase 1 renders images and carousels only.
2. Choose the type variant from the headline length: `A` ≤ 36 characters → the 104 px tier; `B` ≤ 60 → the 84 px tier; `C` longer → the 68 px tier. Record the choice in `designNote`.
3. Render with Playwright (Chromium) at device scale 1 and export JPEG. Devanagari runs are wrapped in `<span lang="hi">` and only ever set in the brand's Devanagari family; Latin runs use the brand's display and UI families. Fonts come from the fontsource packages copied by `npm run build:fonts`; the cmap coverage table decides whether every glyph is covered.
4. Measure inside the page: every text box must fit (no overflow), every text run must be at least 30 units tall at 1080 px width, and the contrast of text on its background must be ≥ 4.5:1 (≥ 3:1 for text ≥ 60 units). Then check the file: JPEG magic bytes, 1080×1350, ≤ 1.5 MB.
5. Name every file by its SHA-256, write it under the media directory, and record `media[]` on the draft (kind, path, bytes, width, height, sha256, raw URL, Pages URL). Move the draft to `rendered`.
6. Refuse — leave the draft in `written`, write `renderError`, log the reason — when any text overflows its box, a glyph is not covered by the chosen font, the contrast rule fails, the JPEG exceeds 1.5 MB, or the media branch worktree is missing (`media_branch_missing`).

Palette rules per brand: RishtaPatra uses the maroon / cream / gold tokens, Cormorant Garamond for display, Tiro Devanagari Hindi for Hindi; KaatDo uses the dark console palette flat (no glow, no shadows) with Space Grotesk and Cascadia Code, light palette for carousel body slides, Noto Sans Devanagari only for "काट दो."; JobRez uses DM Sans / Manrope / DM Mono, the violet tokens, and the violet gradient only on its own tile — the only gradient anywhere in Hoshlab media.

Boundaries: never stock imagery or generated people; never a colour or font that is not in `## Tokens`; never a gradient outside JobRez media; never a change to the Writer's words (if the copy does not fit, refuse and let the Writer rework it).

## Output

The Designer produces files and draft fields, not prose:

- `media[]` entries on the draft: `{ "kind": "image", "path": "media/<draftId>/<sha256>.jpg", "bytes": 0, "width": 1080, "height": 1350, "sha256": "…", "rawUrl": "https://raw.githubusercontent.com/…", "pagesUrl": "https://…" }` (one per image; one per slide for carousels).
- `designNote`: the variant chosen and the palette used, e.g. `variant B · dark console palette`.
- On refusal: `renderError` with the measured reason (`overflow: headline 1134 > 1000 px`, `glyph missing: U+0915 in Space Grotesk`, `jpeg 1.62 MB > 1.5 MB`), status unchanged.

Every number written here is measured in the page or read from the file; nothing is estimated.
