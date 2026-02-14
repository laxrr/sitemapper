function originKey(origin) {
  return `sitemap:${origin}`;
}

async function getActiveTabOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const u = new URL(tab.url);
    if (!u.origin.startsWith("http")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/* -------------------------
   ADVANCED ANALYSIS
------------------------- */

function stripLocale(path) {
  return path.replace(/^\/(fr|en|de|es|it|pt)(\/|$)/, "/");
}

function analyze(urls) {
  const types = {};
  const depths = {};
  const canonical = new Set();

  for (const u of urls) {
    let url;
    try { url = new URL(u); } catch { continue; }

    const cleanPath = stripLocale(url.pathname);
    canonical.add(cleanPath);

    const parts = cleanPath.split("/").filter(Boolean);
    const depth = parts.length;
    depths[depth] = (depths[depth] || 0) + 1;

    const root = parts[0] || "root";
    types[root] = (types[root] || 0) + 1;
  }

  return { types, depths, canonicalCount: canonical.size };
}

function renderAdvanced(urls) {
  const statsEl = document.getElementById("stats");
  const depthEl = document.getElementById("depth");
  if (!statsEl || !depthEl) return;

  const { types, depths, canonicalCount } = analyze(urls);

  const sortedTypes = Object.entries(types).sort((a, b) => b[1] - a[1]);
  const sortedDepths = Object.entries(depths).sort((a, b) => Number(a[0]) - Number(b[0]));

  statsEl.innerHTML = `
    <div class="stat">Total URLs: ${urls.length}</div>
    <div class="stat">Canonical Pages: ${canonicalCount}</div>
    <div class="stat" style="margin-top:8px;">By Type:</div>
    ${sortedTypes.map(([k, v]) => `<div class="stat">${k}: ${v}</div>`).join("")}
  `;

  depthEl.innerHTML = `
    <div class="stat" style="margin-top:10px;">Depth Distribution:</div>
    ${sortedDepths.map(([k, v]) => `<div class="stat">Depth ${k}: ${v}</div>`).join("")}
  `;
}

/* -------------------------
   FILTERING HELPERS
------------------------- */

function detectLocaleFromPath(path) {
  const m = path.match(/^\/([a-z]{2})(\/|$)/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function detectTypeFromPath(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[0] || "root";
}

function buildLocaleOptions(urls) {
  const locales = new Set();
  for (const u of urls) {
    try {
      const url = new URL(u);
      const loc = detectLocaleFromPath(url.pathname);
      if (loc) locales.add(loc);
    } catch {}
  }
  return Array.from(locales).sort();
}

function applyFilters(allUrls, { q, type, locale }) {
  const qLower = (q || "").trim().toLowerCase();

  return allUrls.filter(u => {
    let url;
    try { url = new URL(u); } catch { return false; }

    const path = url.pathname;
    const urlStr = u.toLowerCase();

    // search
    if (qLower && !urlStr.includes(qLower)) return false;

    // locale filter
    if (locale && locale !== "__all__") {
      const loc = detectLocaleFromPath(path);
      if (loc !== locale) return false;
    }

    // type filter (based on first non-locale segment)
    if (type && type !== "__all__") {
      const pathNoLocale = stripLocale(path);
      const t = detectTypeFromPath(pathNoLocale);
      if (t !== type) return false;
    }

    return true;
  });
}

/* -------------------------
   STATE
------------------------- */

let ALL_URLS = [];
let FILTERED_URLS = [];

/* -------------------------
   RENDER BASIC
------------------------- */

function renderBasic(urlsToShow) {
  const urlsEl = document.getElementById("urls");
  if (urlsEl) urlsEl.value = urlsToShow.join("\n");

  const metaEl = document.getElementById("meta");
  if (metaEl) {
    // Keep the "Found • X URLs" message from run(), but we’ll also show filtered count in detail.
  }

  const detailEl = document.getElementById("detail");
  if (detailEl) {
    detailEl.innerHTML = detailEl.innerHTML; // keep whatever run() set (scanned + sitemap link)
  }
}

function updateDetailFilteredCount() {
  const detailEl = document.getElementById("detail");
  if (!detailEl) return;

  // Append filtered count line without nuking scan/sitemap info
  const base = detailEl.getAttribute("data-base") || detailEl.innerHTML;

  const line = `<br>Showing: <b>${FILTERED_URLS.length}</b> / ${ALL_URLS.length}`;
  detailEl.innerHTML = base + line;
}

/* -------------------------
   POPUP BOOT
------------------------- */

async function run() {
  const siteEl = document.getElementById("site");
  const metaEl = document.getElementById("meta");
  const detailEl = document.getElementById("detail");

  const origin = await getActiveTabOrigin();
  if (!origin) {
    if (siteEl) siteEl.textContent = "Sitemap";
    if (metaEl) metaEl.textContent = "Open a normal website tab (http/https).";
    ALL_URLS = [];
    FILTERED_URLS = [];
    renderBasic([]);
    renderAdvanced([]);
    return;
  }

  if (siteEl) siteEl.textContent = origin;

  const key = originKey(origin);
  const data = await chrome.storage.local.get(key);
  const rec = data?.[key];

  if (!rec) {
    if (metaEl) metaEl.textContent = "No data yet. Reload the page once.";
    ALL_URLS = [];
    FILTERED_URLS = [];
    renderBasic([]);
    renderAdvanced([]);
    return;
  }

  if (metaEl) {
    metaEl.textContent = rec.found
      ? `Found • ${rec.urlCount} URLs`
      : `No sitemap found (cached)`;
  }

  ALL_URLS = Array.isArray(rec.urls) ? rec.urls : [];
  FILTERED_URLS = [...ALL_URLS];

  // Build locale dropdown options dynamically
  const localeSelect = document.getElementById("locale");
  if (localeSelect) {
    const locales = buildLocaleOptions(ALL_URLS);
    localeSelect.innerHTML = `<option value="__all__">Locale: All</option>` +
      locales.map(l => `<option value="${l}">${l.toUpperCase()}</option>`).join("");
  }

  // Set scan + sitemap details
  const scanned = rec.scannedAt ? new Date(rec.scannedAt).toLocaleString() : "unknown";
  const sitemap = rec.sitemapUrl ? rec.sitemapUrl : "none";

  if (detailEl) {
    const baseHtml =
      `Scanned: <b>${scanned}</b><br>` +
      `Sitemap: ${rec.sitemapUrl ? `<a href="${sitemap}" target="_blank">${sitemap}</a>` : "<b>none</b>"}`;

    // Store base so we can append filtered counts cleanly
    detailEl.setAttribute("data-base", baseHtml);
    detailEl.innerHTML = baseHtml;
  }

  // Render both tabs
  renderBasic(FILTERED_URLS);
  renderAdvanced(ALL_URLS);
  updateDetailFilteredCount();
}

/* -------------------------
   BUTTONS
------------------------- */

document.getElementById("copy")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(ALL_URLS.join("\n"));
});

document.getElementById("copyFiltered")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(FILTERED_URLS.join("\n"));
});

document.getElementById("refresh")?.addEventListener("click", async () => {
  const origin = await getActiveTabOrigin();
  if (!origin) return;
  await chrome.storage.local.remove(originKey(origin));

  const metaEl = document.getElementById("meta");
  if (metaEl) metaEl.textContent = "Cache cleared. Reload the tab to rescan.";

  ALL_URLS = [];
  FILTERED_URLS = [];
  renderBasic([]);
  renderAdvanced([]);
});

document.getElementById("apply")?.addEventListener("click", () => {
  const q = document.getElementById("q")?.value || "";
  const type = document.getElementById("type")?.value || "__all__";
  const locale = document.getElementById("locale")?.value || "__all__";

  FILTERED_URLS = applyFilters(ALL_URLS, { q, type, locale });
  renderBasic(FILTERED_URLS);
  updateDetailFilteredCount();
});

document.getElementById("clear")?.addEventListener("click", () => {
  const qEl = document.getElementById("q");
  const typeEl = document.getElementById("type");
  const localeEl = document.getElementById("locale");

  if (qEl) qEl.value = "";
  if (typeEl) typeEl.value = "__all__";
  if (localeEl) localeEl.value = "__all__";

  FILTERED_URLS = [...ALL_URLS];
  renderBasic(FILTERED_URLS);
  updateDetailFilteredCount();
});

/* -------------------------
   TAB SWITCHING
------------------------- */

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));

    tab.classList.add("active");
    document.getElementById(tab.dataset.tab)?.classList.add("active");
  });
});

run().catch(() => {});