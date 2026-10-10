import config from "../../site.config.js";

// Every internal href/src goes through url() so the site works under a sub-path.
export function url(path = "") {
  return config.basePath + String(path).replace(/^\/+/, "");
}

// Absolute URL for feed/sitemap/canonical/og only.
export function absUrl(path = "") {
  const origin = new URL(config.siteUrl).origin;
  return origin + url(path);
}
