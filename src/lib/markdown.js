// Safe Markdown → HTML for owner-editable text the site prints (brand.md Voice bullets today; memos,
// reports and HR reviews in Phase 2). marked 18.1.0 with raw HTML escaped instead of passed through, so
// a stray tag in a Markdown file can never inject markup, inline styles or scripts into the public site.
import { Marked } from "marked";
import { escapeHtml } from "./xml.js";

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(markdown) {
  return marked.parse(String(markdown ?? "")).trim();
}

// Inline-only rendering (no <p> wrapper): emphasis, code and links inside one line of text.
export function renderInline(markdown) {
  return marked.parseInline(String(markdown ?? "")).trim();
}
