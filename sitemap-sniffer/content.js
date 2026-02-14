// Sitemap Sniffer (content script)
// Runs on page load, discovers sitemap entry points, recursively parses sitemap
// indexes/urlsets, and stores a normalized record in chrome.storage.local.

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours per origin cache
const LIMITS = {
  maxDepth: 3,
  maxSitemapsFetched: 30,
  maxUrlsStored: 10000
};

function originKey(origin) {
  return `sitemap:${origin}`;
}

function now() {
  return Date.now();
}

function safeUrl(u, base) {
  try { return new URL(u, base); } catch { return null; }
}

function errMsg(err) {
  return String(err?.message || err || "unknown error");
}

function pushError(state, message) {
  if (!message) return;
  state.errors.push(String(message));
}

function pushTried(state, url, status, error) {
  const row = { url: String(url), status };
  if (error) row.error = String(error);
  state.tried.push(row);
}

function markTruncated(state) {
  if (state.truncated) return;
  state.truncated = true;
  pushError(state, `URL list truncated at ${state.limits.maxUrlsStored}.`);
}

function normalizeUrl(u) {
  const url = safeUrl(String(u || "").trim());
  if (!url) return null;

  if (url.pathname.endsWith("/index.html")) {
    url.pathname = `${url.pathname.slice(0, -"/index.html".length)}/`;
  }

  return url.toString();
}

function parseRobotsForSitemaps(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(.+?)\s*$/i);
    if (!match?.[1]) continue;
    const cleaned = match[1].replace(/\s+#.*$/, "").trim();
    if (cleaned) out.push(cleaned);
  }
  return Array.from(new Set(out));
}

function candidateSitemapUrls(origin) {
  return [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap.xml.gz`,
    `${origin}/sitemap-index.xml.gz`,
    `${origin}/sitemap_index.xml.gz`
  ];
}

async function responseToSitemapText(res, sitemapUrl, state) {
  const encoding = (res.headers.get("content-encoding") || "").toLowerCase();
  const looksGzip = encoding.includes("gzip") || sitemapUrl.toLowerCase().endsWith(".gz");

  if (!looksGzip) {
    return res.text();
  }

  if (typeof DecompressionStream === "undefined") {
    pushError(state, `Cannot parse gzip sitemap ${sitemapUrl}: DecompressionStream unavailable.`);
    return null;
  }

  try {
    const ab = await res.arrayBuffer();
    const ds = new DecompressionStream("gzip");
    const decompressed = new Response(new Blob([ab]).stream().pipeThrough(ds));
    return await decompressed.text();
  } catch (err) {
    pushError(state, `Failed to decompress gzip sitemap ${sitemapUrl}: ${errMsg(err)}`);
    return null;
  }
}

function parseSitemapXml(xmlText, sitemapUrl, state) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    pushError(state, `XML parse error in ${sitemapUrl}.`);
    return null;
  }

  const rootName = (
    doc.documentElement?.localName ||
    doc.documentElement?.tagName ||
    ""
  ).toLowerCase();

  const locNodes = Array.from(doc.getElementsByTagName("loc"));
  const locs = [];
  for (const node of locNodes) {
    const raw = node.textContent?.trim();
    if (!raw) continue;

    const resolved = safeUrl(raw, sitemapUrl);
    if (!resolved) {
      pushError(state, `Invalid <loc> in ${sitemapUrl}: ${raw}`);
      continue;
    }
    locs.push(resolved.toString());
  }

  if (rootName === "sitemapindex") {
    return { kind: "sitemapindex", locs };
  }
  if (rootName === "urlset") {
    return { kind: "urlset", locs };
  }

  pushError(state, `Unknown sitemap format at ${sitemapUrl}.`);
  return null;
}

async function fetchAndParseSitemap(url, depth, state) {
  if (depth > state.limits.maxDepth) {
    pushError(state, `Max sitemap depth exceeded at ${url}.`);
    return;
  }

  const sitemapUrl = safeUrl(url, state.origin)?.toString();
  if (!sitemapUrl) {
    pushError(state, `Invalid sitemap URL: ${url}`);
    pushTried(state, url, 0, "invalid-url");
    return;
  }

  if (state.visitedSitemaps.has(sitemapUrl)) return;

  if (state.sitemapsFetched >= state.limits.maxSitemapsFetched) {
    pushError(state, `Max sitemaps fetched reached (${state.limits.maxSitemapsFetched}).`);
    return;
  }

  state.visitedSitemaps.add(sitemapUrl);
  state.sitemapsFetched += 1;

  let res;
  try {
    res = await fetch(sitemapUrl, { credentials: "omit", cache: "no-store" });
  } catch (err) {
    pushTried(state, sitemapUrl, 0, errMsg(err));
    pushError(state, `Fetch failed for ${sitemapUrl}: ${errMsg(err)}`);
    return;
  }

  pushTried(state, sitemapUrl, res.status);
  if (!res.ok) {
    pushError(state, `Sitemap fetch failed ${res.status} for ${sitemapUrl}.`);
    return;
  }

  const xmlText = await responseToSitemapText(res, sitemapUrl, state);
  if (!xmlText) return;

  const parsed = parseSitemapXml(xmlText, sitemapUrl, state);
  if (!parsed) return;

  if (!state.primarySitemapUrl) {
    state.primarySitemapUrl = sitemapUrl;
  }

  if (parsed.kind === "urlset") {
    for (const loc of parsed.locs) {
      if (state.urls.size >= state.limits.maxUrlsStored) {
        markTruncated(state);
        break;
      }

      const normalized = normalizeUrl(loc);
      if (!normalized) continue;
      state.urls.add(normalized);
    }
    return;
  }

  if (depth >= state.limits.maxDepth) {
    pushError(state, `Max sitemap recursion depth reached at ${sitemapUrl}.`);
    return;
  }

  for (const childSitemap of parsed.locs) {
    if (state.sitemapsFetched >= state.limits.maxSitemapsFetched) {
      pushError(state, `Max sitemaps fetched reached (${state.limits.maxSitemapsFetched}).`);
      break;
    }

    await fetchAndParseSitemap(childSitemap, depth + 1, state);

    if (state.urls.size >= state.limits.maxUrlsStored) {
      markTruncated(state);
      break;
    }
  }
}

async function scanAndStore() {
  const origin = location.origin;
  if (!origin.startsWith("http")) return;

  const key = originKey(origin);

  const state = {
    origin,
    urls: new Set(),
    tried: [],
    errors: [],
    visitedSitemaps: new Set(),
    sitemapsFetched: 0,
    primarySitemapUrl: null,
    truncated: false,
    limits: { ...LIMITS }
  };

  try {
    const existing = await chrome.storage.local.get(key);
    const record = existing?.[key];
    if (record?.scannedAt && now() - record.scannedAt < TTL_MS) return;
  } catch (err) {
    pushError(state, `Cache read failed: ${errMsg(err)}`);
  }

  try {
    const robotsUrl = `${origin}/robots.txt`;
    let robotsSitemaps = [];

    try {
      const robotsRes = await fetch(robotsUrl, { credentials: "omit", cache: "no-store" });
      pushTried(state, robotsUrl, robotsRes.status);

      if (robotsRes.ok) {
        const robotsText = await robotsRes.text();
        robotsSitemaps = parseRobotsForSitemaps(robotsText)
          .map(s => safeUrl(s, origin)?.toString())
          .filter(Boolean);
      } else {
        pushError(state, `robots.txt fetch failed ${robotsRes.status}.`);
      }
    } catch (err) {
      pushTried(state, robotsUrl, 0, errMsg(err));
      pushError(state, `robots.txt fetch failed: ${errMsg(err)}`);
    }

    const sitemapCandidates = robotsSitemaps.length
      ? robotsSitemaps
      : candidateSitemapUrls(origin);

    const uniqueCandidates = Array.from(new Set(sitemapCandidates));
    for (const candidate of uniqueCandidates) {
      if (state.sitemapsFetched >= state.limits.maxSitemapsFetched) {
        pushError(state, `Max sitemaps fetched reached (${state.limits.maxSitemapsFetched}).`);
        break;
      }
      await fetchAndParseSitemap(candidate, 0, state);
    }
  } catch (err) {
    pushError(state, `Unexpected scan error: ${errMsg(err)}`);
  }

  const urls = Array.from(state.urls).slice(0, state.limits.maxUrlsStored);
  const found = urls.length > 0;

  await chrome.storage.local.set({
    [key]: {
      origin,
      found,
      urlCount: urls.length,
      urls,
      scannedAt: now(),
      sitemapUrl: found ? state.primarySitemapUrl : null,
      tried: state.tried,
      errors: state.errors,
      truncated: state.truncated,
      limits: state.limits
    }
  });
}

scanAndStore().catch(() => {});
