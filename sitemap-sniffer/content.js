// Sitemap Sniffer (content script)
// Runs on every page load, attempts to find sitemaps for the current origin,
// parses them, cleans URLs, and stores results in chrome.storage.local.

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours per origin cache
const MAX_URLS = 4000;            // safety cap
const MAX_FETCH_BYTES = 3_000_000; // ~3MB cap per fetch

function originKey(origin) {
  return `sitemap:${origin}`;
}

function now() {
  return Date.now();
}

function safeUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function normalizeUrl(u) {
  // Cleanse: strip hash + query, trim whitespace, normalize trailing slash (lightly)
  const url = safeUrl(u?.trim());
  if (!url) return null;

  url.hash = "";
  url.search = "";

  // Optional: normalize "index.html" -> "/" (common cleanup)
  if (url.pathname.endsWith("/index.html")) {
    url.pathname = url.pathname.slice(0, -"/index.html".length) + "/";
  }

  // Optional: remove duplicate trailing slash except root
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    // keep single trailing slash; fine as-is
  }

  return url.toString();
}

async function fetchTextCapped(url) {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);

  // Cap size by reading as text and slicing
  const text = await res.text();
  if (text.length > MAX_FETCH_BYTES) {
    return text.slice(0, MAX_FETCH_BYTES);
  }
  return text;
}

function extractSitemapLinksFromRobots(robotsText) {
  // robots.txt can include multiple lines: Sitemap: https://example.com/sitemap.xml
  const out = [];
  const lines = robotsText.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*sitemap\s*:\s*(.+)\s*$/i);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

function extractSitemapRelLinkFromDom() {
  // Some sites use: <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
  const links = Array.from(document.querySelectorAll('link[rel="sitemap"][href]'));
  return links.map(l => l.getAttribute("href")).filter(Boolean);
}

function parseXmlLocs(xmlText) {
  // Parse sitemap XML and return list of <loc> contents.
  // Handles both urlset and sitemapindex (index returns child sitemap URLs).
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  // If parse error:
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) return { locs: [], isIndex: false, parseError: true };

  const locEls = Array.from(doc.getElementsByTagName("loc"));
  const locs = locEls.map(el => el.textContent?.trim()).filter(Boolean);

  const root = doc.documentElement?.tagName?.toLowerCase();
  const isIndex = root === "sitemapindex";

  return { locs, isIndex, parseError: false };
}

async function discoverCandidateSitemaps(origin) {
  const candidates = new Set();

  // 1) Common defaults
  candidates.add(`${origin}/sitemap.xml`);
  candidates.add(`${origin}/sitemap_index.xml`);
  candidates.add(`${origin}/sitemap-index.xml`);

  // 2) <link rel="sitemap" ...> on page
  for (const href of extractSitemapRelLinkFromDom()) {
    try {
      candidates.add(new URL(href, origin).toString());
    } catch {}
  }

  // 3) robots.txt "Sitemap:" directives
  try {
    const robots = await fetchTextCapped(`${origin}/robots.txt`);
    for (const s of extractSitemapLinksFromRobots(robots)) {
      try {
        candidates.add(new URL(s, origin).toString());
      } catch {}
    }
  } catch {
    // ignore robots.txt failures
  }

  return Array.from(candidates);
}

async function tryGetSitemapUrlsFromSitemapUrl(sitemapUrl, depth = 0) {
  // depth: follow sitemap indexes a bit, but not infinitely
  if (depth > 2) return { pageUrls: [], seenSitemaps: [sitemapUrl] };

  const xml = await fetchTextCapped(sitemapUrl);
  const { locs, isIndex, parseError } = parseXmlLocs(xml);
  if (parseError) return { pageUrls: [], seenSitemaps: [sitemapUrl] };

  if (!isIndex) {
    return { pageUrls: locs, seenSitemaps: [sitemapUrl] };
  }

  // It's a sitemap index; locs are child sitemap URLs
  const allPageUrls = [];
  const allSeen = [sitemapUrl];

  for (const child of locs.slice(0, 50)) { // cap number of child sitemaps
    try {
      const childRes = await tryGetSitemapUrlsFromSitemapUrl(child, depth + 1);
      allSeen.push(...childRes.seenSitemaps);
      allPageUrls.push(...childRes.pageUrls);
      if (allPageUrls.length >= MAX_URLS) break;
    } catch {
      // ignore child failures
    }
  }

  return { pageUrls: allPageUrls.slice(0, MAX_URLS), seenSitemaps: allSeen };
}

async function scanAndStore() {
  const origin = location.origin;
  const key = originKey(origin);

  // Avoid scanning chrome://, extensions, file://, etc.
  if (!origin.startsWith("http")) return;

  // Cache / TTL check
  const existing = await chrome.storage.local.get(key);
  const record = existing?.[key];
  if (record?.scannedAt && now() - record.scannedAt < TTL_MS) return;

  const candidates = await discoverCandidateSitemaps(origin);

  let foundSitemap = null;
  let foundUrls = [];
  let tried = [];
  let seenSitemaps = [];

  for (const c of candidates) {
    tried.push(c);
    try {
      const { pageUrls, seenSitemaps: seen } = await tryGetSitemapUrlsFromSitemapUrl(c);
      if (pageUrls && pageUrls.length) {
        foundSitemap = c;
        seenSitemaps = seen;
        foundUrls = pageUrls;
        break;
      }
    } catch {
      // try next
    }
  }

  // Clean + dedupe + keep only same-origin URLs (optional, but matches your “site sitemap” intent)
  const cleanedSet = new Set();
  for (const u of foundUrls) {
    const norm = normalizeUrl(u);
    if (!norm) continue;

    try {
      const urlObj = new URL(norm);
      if (urlObj.origin !== origin) continue; // keep only current origin
      cleanedSet.add(norm);
      if (cleanedSet.size >= MAX_URLS) break;
    } catch {}
  }

  const cleaned = Array.from(cleanedSet);

  await chrome.storage.local.set({
    [key]: {
      origin,
      scannedAt: now(),
      found: Boolean(foundSitemap),
      sitemapUrl: foundSitemap,
      sitemapUrlsFollowed: seenSitemaps,
      urlCount: cleaned.length,
      urls: cleaned,
      tried
    }
  });
}

scanAndStore().catch(() => {});