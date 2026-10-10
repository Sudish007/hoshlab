// feed.xml / sitemap.xml well-formedness (fast-xml-parser) and content derived from the fixture state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import config from "../site.config.js";
import { parseJsonl } from "../engine/lib/state.js";
import { DIST, COMPANY_DIR, read } from "./helpers.js";

const published = parseJsonl(read(join(COMPANY_DIR, "state", "published.jsonl"))).filter((r) => !r.dryRun);
const fixtureConfig = JSON.parse(read(join(COMPANY_DIR, "config.json")));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

test("feed.xml is well-formed Atom with one entry per published post (dry runs excluded), newest first", () => {
  const xml = read(join(DIST, "feed.xml"));
  assert.equal(XMLValidator.validate(xml), true);
  const feed = parser.parse(xml).feed;
  assert.equal(feed["@_xmlns"], "http://www.w3.org/2005/Atom");
  assert.equal(feed.title, `${config.title} — published posts`);
  const entries = [].concat(feed.entry || []);
  assert.equal(entries.length, published.length);
  assert.equal(published.length, 2, "the fixture publishes two posts");
  const sorted = published.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  entries.forEach((e, i) => {
    assert.equal(e.link["@_href"], sorted[i].permalink, "entry links to the Instagram permalink");
    assert.equal(e.published, sorted[i].publishedAt);
    assert.equal(e.id, `${config.siteUrl}/published/#${sorted[i].draftId}`);
    assert.ok([].concat(e.category).some((c) => c["@_term"] === sorted[i].page));
    assert.ok(String(e.content["#text"]).includes("#"), "the caption as posted, hashtags included");
  });
  assert.equal(feed.updated, sorted[0].publishedAt);
  assert.ok(!/admin/i.test(xml));
});

test("sitemap.xml is well-formed and lists exactly the public routes under siteUrl", () => {
  const xml = read(join(DIST, "sitemap.xml"));
  assert.equal(XMLValidator.validate(xml), true);
  const urls = [].concat(parser.parse(xml).urlset.url).map((u) => u.loc);
  const expected = ["", "team/", "pages/", ...fixtureConfig.pages.map((p) => `pages/${p.handle}/`), "activity/", "calendar/", "published/", "reports/", "about/"].map((p) => `${config.siteUrl}/${p}`);
  assert.deepEqual(urls, expected);
  for (const u of urls) assert.ok(u.startsWith(config.siteUrl) && !/admin/.test(u), u);
});

test("robots.txt allows everything, names the sitemap and never mentions admin (N9)", () => {
  const robots = read(join(DIST, "robots.txt"));
  assert.equal(robots, `User-agent: *\nAllow: /\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
});
