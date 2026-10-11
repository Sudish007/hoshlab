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

// A whole engine-written document (an Analyst report) inside a page that already has its own <h1>: no heading is
// rendered above h2, raw HTML is escaped as above, links and images are printed as text, and every GFM table is
// wrapped in the captioned horizontal scroller the design allows (review M12: `.table-wrap` + "scroll →"), so a wide
// table scrolls inside its box at 390 px instead of pushing the page sideways.
const document = new Marked({ gfm: true, breaks: false });
document.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    // The page already has its h1 (the hero): a document-level '# title' becomes an h2 and the '##' sections stay
    // h2, so the outline under the page title never skips a level.
    heading({ tokens, depth }) {
      const level = Math.min(6, Math.max(2, depth));
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    // A report carries no links or images: a model-written URL is printed as its text (no outbound link, no 44 px
    // control inside running text to audit), an image as its alt text.
    link({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    image({ text }) {
      return escapeHtml(text || "");
    },
    table(token) {
      const header = `<tr>${token.header.map((cell) => this.tablecell(cell)).join("")}</tr>`;
      const rows = token.rows.map((row) => `<tr>${row.map((cell) => this.tablecell(cell)).join("")}</tr>`).join("\n");
      return `<figure class="table-wrap"><figcaption class="meta">scroll →</figcaption>\n<table class="table">\n<thead>\n${header}\n</thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n</figure>\n`;
    },
    tablecell(token) {
      const content = this.parser.parseInline(token.tokens);
      const tag = token.header ? "th" : "td";
      const align = token.align ? ` class="align-${token.align}"` : "";
      return `<${tag}${token.header ? ' scope="col"' : ""}${align}>${content}</${tag}>`;
    },
  },
});

export function renderDocument(markdown) {
  return document.parse(String(markdown ?? "")).trim();
}

// Inline-only rendering (no <p> wrapper): emphasis, code and links inside one line of text.
export function renderInline(markdown) {
  return marked.parseInline(String(markdown ?? "")).trim();
}
