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

function pct(n, d) {
  if (!d || d <= 0) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function countMatches(urls, needle) {
  const s = String(needle || "").toLowerCase();
  if (!s) return 0;

  let count = 0;
  for (const u of urls || []) {
    let haystack = "";
    try {
      haystack = new URL(u).pathname.toLowerCase();
    } catch {
      haystack = String(u || "").toLowerCase();
    }

    if (haystack.includes(s)) count += 1;
  }

  return count;
}

function buildAlerts(allUrls) {
  const urls = Array.isArray(allUrls) ? allUrls : [];
  const totalUrls = urls.length;
  const alerts = [];

  if (!totalUrls) {
    return [{ level: "green", msg: "No obvious red flags detected." }];
  }

  const { types, depths, canonicalCount } = analyze(urls);

  // A) Canonical ratio
  const canonicalRatio = canonicalCount / totalUrls;
  if (canonicalRatio < 0.35) {
    alerts.push({
      level: "red",
      msg: `Low canonical ratio: ${pct(canonicalCount, totalUrls)} (${canonicalCount}/${totalUrls}).`
    });
  } else if (canonicalRatio <= 0.60) {
    alerts.push({
      level: "yellow",
      msg: `Canonical ratio is borderline: ${pct(canonicalCount, totalUrls)} (${canonicalCount}/${totalUrls}).`
    });
  }

  // B) Unexpected types
  const known = new Set(["products", "collections", "pages", "blogs", "root"]);
  let unknownCount = 0;
  for (const [type, count] of Object.entries(types)) {
    if (!known.has(type)) unknownCount += count;
  }
  const unknownRatio = unknownCount / totalUrls;
  if (unknownRatio > 0.01) {
    alerts.push({
      level: "red",
      msg: `Unexpected URL types are high: ${pct(unknownCount, totalUrls)} (${unknownCount}/${totalUrls}).`
    });
  } else if (unknownRatio > 0.002) {
    alerts.push({
      level: "yellow",
      msg: `Unexpected URL types detected: ${pct(unknownCount, totalUrls)} (${unknownCount}/${totalUrls}).`
    });
  }

  // C) Deep URLs (depth >= 5)
  let deepCount = 0;
  for (const [depth, count] of Object.entries(depths)) {
    if (Number(depth) >= 5) deepCount += count;
  }
  const deepRatio = deepCount / totalUrls;
  if (deepRatio > 0.10) {
    alerts.push({
      level: "red",
      msg: `Too many deep URLs (depth >= 5): ${pct(deepCount, totalUrls)} (${deepCount}/${totalUrls}).`
    });
  } else if (deepRatio > 0.03) {
    alerts.push({
      level: "yellow",
      msg: `Deep URL share is elevated (depth >= 5): ${pct(deepCount, totalUrls)} (${deepCount}/${totalUrls}).`
    });
  }

  // D) "copy-of" products
  const copyOfCount = countMatches(urls, "/products/copy-of-");
  const productCount = types["products"] || 0;
  const copyRatio = productCount ? copyOfCount / productCount : 0;
  if (copyRatio > 0.02) {
    alerts.push({
      level: "red",
      msg: `High "copy-of" product ratio: ${pct(copyOfCount, productCount)} (${copyOfCount}/${productCount}).`
    });
  } else if (copyRatio > 0.005) {
    alerts.push({
      level: "yellow",
      msg: `"copy-of" products detected: ${pct(copyOfCount, productCount)} (${copyOfCount}/${productCount}).`
    });
  }

  if (!alerts.length) {
    alerts.push({ level: "green", msg: "No obvious red flags detected." });
  }

  return alerts;
}

function renderAlerts(allUrls) {
  const alertsEl = document.getElementById("alerts");
  if (!alertsEl) return;

  const icons = { green: "✅", yellow: "⚠️", red: "🚩" };
  const colors = { green: "#1d6f42", yellow: "#8a5a00", red: "#a31818" };
  const alerts = buildAlerts(allUrls);

  alertsEl.innerHTML = alerts
    .map(a => `<div class="stat" style="color:${colors[a.level] || "inherit"};">${icons[a.level] || "✅"} ${a.msg}</div>`)
    .join("");
}

function renderAdvanced(urls) {
  renderAlerts(urls);

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

    if (qLower && !urlStr.includes(qLower)) return false;

    if (locale && locale !== "__all__") {
      const loc = detectLocaleFromPath(path);
      if (loc !== locale) return false;
    }

    if (type && type !== "__all__") {
      const pathNoLocale = stripLocale(path);
      const t = detectTypeFromPath(pathNoLocale);
      if (t !== type) return false;
    }

    return true;
  });
}

/* -------------------------
   DOWNLOAD HELPERS
------------------------- */

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* -------------------------
   STATE
------------------------- */

let ORIGIN = null;
let REC = null;

let ALL_URLS = [];
let FILTERED_URLS = [];

let PAGE_INDEX = 0;
let PAGE_SIZE = 200;

/* -------------------------
   PAGINATION
------------------------- */

function totalPages() {
  return Math.max(1, Math.ceil(FILTERED_URLS.length / PAGE_SIZE));
}

function clampPageIndex() {
  const tp = totalPages();
  if (PAGE_INDEX < 0) PAGE_INDEX = 0;
  if (PAGE_INDEX > tp - 1) PAGE_INDEX = tp - 1;
}

function currentPageSlice() {
  clampPageIndex();
  const start = PAGE_INDEX * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  return FILTERED_URLS.slice(start, end);
}

function updatePagerUi() {
  const infoEl = document.getElementById("pageInfo");
  const prevBtn = document.getElementById("prevPage");
  const nextBtn = document.getElementById("nextPage");

  const tp = totalPages();
  clampPageIndex();

  if (infoEl) infoEl.textContent = `Page ${PAGE_INDEX + 1} of ${tp}`;
  if (prevBtn) prevBtn.disabled = PAGE_INDEX <= 0;
  if (nextBtn) nextBtn.disabled = PAGE_INDEX >= tp - 1;
}

/* -------------------------
   RENDER BASIC
------------------------- */

function renderBasic() {
  const urlsEl = document.getElementById("urls");
  if (urlsEl) urlsEl.value = currentPageSlice().join("\n");

  updatePagerUi();
  updateDetailFilteredCount();
}

function updateDetailFilteredCount() {
  const detailEl = document.getElementById("detail");
  if (!detailEl) return;

  const base = detailEl.getAttribute("data-base") || detailEl.innerHTML;

  const start = PAGE_INDEX * PAGE_SIZE + 1;
  const end = Math.min((PAGE_INDEX + 1) * PAGE_SIZE, FILTERED_URLS.length);
  const shownRange = FILTERED_URLS.length ? `${start}-${end}` : `0-0`;

  const line =
    `<br>Showing: <b>${FILTERED_URLS.length}</b> / ${ALL_URLS.length}` +
    `<br>Page: <b>${shownRange}</b>`;

  detailEl.innerHTML = base + line;
}

/* -------------------------
   POPUP BOOT
------------------------- */

async function run() {
  const siteEl = document.getElementById("site");
  const metaEl = document.getElementById("meta");
  const detailEl = document.getElementById("detail");

  ORIGIN = await getActiveTabOrigin();
  if (!ORIGIN) {
    if (siteEl) siteEl.textContent = "Sitemap";
    if (metaEl) metaEl.textContent = "Open a normal website tab (http/https).";
    ALL_URLS = [];
    FILTERED_URLS = [];
    PAGE_INDEX = 0;
    renderBasic();
    renderAdvanced([]);
    return;
  }

  if (siteEl) siteEl.textContent = ORIGIN;

  const key = originKey(ORIGIN);
  const data = await chrome.storage.local.get(key);
  REC = data?.[key];

  if (!REC) {
    if (metaEl) metaEl.textContent = "No data yet. Reload the page once.";
    ALL_URLS = [];
    FILTERED_URLS = [];
    PAGE_INDEX = 0;
    renderBasic();
    renderAdvanced([]);
    return;
  }

  if (metaEl) {
    metaEl.textContent = REC.found
      ? `Found • ${REC.urlCount} URLs`
      : `No sitemap found (cached)`;
  }

  ALL_URLS = Array.isArray(REC.urls) ? REC.urls : [];
  FILTERED_URLS = [...ALL_URLS];

  // Locale dropdown options
  const localeSelect = document.getElementById("locale");
  if (localeSelect) {
    const locales = buildLocaleOptions(ALL_URLS);
    localeSelect.innerHTML =
      `<option value="__all__">Locale: All</option>` +
      locales.map(l => `<option value="${l}">${l.toUpperCase()}</option>`).join("");
  }

  // Page size selector
  const pageSizeEl = document.getElementById("pageSize");
  if (pageSizeEl) {
    PAGE_SIZE = Number(pageSizeEl.value) || 200;
  }

  // Detail area
  const scanned = REC.scannedAt ? new Date(REC.scannedAt).toLocaleString() : "unknown";
  const sitemap = REC.sitemapUrl ? REC.sitemapUrl : null;

  if (detailEl) {
    const baseHtml =
      `Scanned: <b>${scanned}</b><br>` +
      `Sitemap: ${sitemap ? `<a href="${sitemap}" target="_blank">${sitemap}</a>` : "<b>none</b>"}`;

    detailEl.setAttribute("data-base", baseHtml);
    detailEl.innerHTML = baseHtml;
  }

  PAGE_INDEX = 0;
  renderBasic();
  renderAdvanced(ALL_URLS);
}

/* -------------------------
   BUTTONS / EVENTS
------------------------- */

// Copy
document.getElementById("copy")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(ALL_URLS.join("\n"));
});

document.getElementById("copyFiltered")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(FILTERED_URLS.join("\n"));
});

document.getElementById("copyPage")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentPageSlice().join("\n"));
});

// Apply / Clear
document.getElementById("apply")?.addEventListener("click", () => {
  const q = document.getElementById("q")?.value || "";
  const type = document.getElementById("type")?.value || "__all__";
  const locale = document.getElementById("locale")?.value || "__all__";

  FILTERED_URLS = applyFilters(ALL_URLS, { q, type, locale });
  PAGE_INDEX = 0;
  renderBasic();
});

document.getElementById("clear")?.addEventListener("click", () => {
  const qEl = document.getElementById("q");
  const typeEl = document.getElementById("type");
  const localeEl = document.getElementById("locale");

  if (qEl) qEl.value = "";
  if (typeEl) typeEl.value = "__all__";
  if (localeEl) localeEl.value = "__all__";

  FILTERED_URLS = [...ALL_URLS];
  PAGE_INDEX = 0;
  renderBasic();
});

// Pagination
document.getElementById("pageSize")?.addEventListener("change", (e) => {
  PAGE_SIZE = Number(e.target.value) || 200;
  PAGE_INDEX = 0;
  renderBasic();
});

document.getElementById("prevPage")?.addEventListener("click", () => {
  PAGE_INDEX -= 1;
  renderBasic();
});

document.getElementById("nextPage")?.addEventListener("click", () => {
  PAGE_INDEX += 1;
  renderBasic();
});

// Open links
document.getElementById("openSitemap")?.addEventListener("click", async () => {
  if (!REC?.sitemapUrl) return;
  await chrome.tabs.create({ url: REC.sitemapUrl });
});

document.getElementById("openRobots")?.addEventListener("click", async () => {
  if (!ORIGIN) return;
  await chrome.tabs.create({ url: `${ORIGIN}/robots.txt` });
});

// Export JSON
function currentFilters() {
  return {
    q: document.getElementById("q")?.value || "",
    type: document.getElementById("type")?.value || "__all__",
    locale: document.getElementById("locale")?.value || "__all__",
    pageSize: PAGE_SIZE,
    pageIndex: PAGE_INDEX
  };
}

document.getElementById("exportJson")?.addEventListener("click", () => {
  if (!ORIGIN) return;

  const payload = {
    origin: ORIGIN,
    scannedAt: REC?.scannedAt || null,
    sitemapUrl: REC?.sitemapUrl || null,
    urlCount: ALL_URLS.length,
    filters: currentFilters(),
    urls: ALL_URLS
  };

  const safeHost = ORIGIN.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_");
  downloadJson(`sitemap_${safeHost}_all.json`, payload);
});

document.getElementById("exportJsonFiltered")?.addEventListener("click", () => {
  if (!ORIGIN) return;

  const payload = {
    origin: ORIGIN,
    scannedAt: REC?.scannedAt || null,
    sitemapUrl: REC?.sitemapUrl || null,
    urlCount: FILTERED_URLS.length,
    filters: currentFilters(),
    urls: FILTERED_URLS
  };

  const safeHost = ORIGIN.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_");
  downloadJson(`sitemap_${safeHost}_filtered.json`, payload);
});

// Refresh (clear cache)
document.getElementById("refresh")?.addEventListener("click", async () => {
  const origin = await getActiveTabOrigin();
  if (!origin) return;

  await chrome.storage.local.remove(originKey(origin));

  const metaEl = document.getElementById("meta");
  if (metaEl) metaEl.textContent = "Cache cleared. Reload the tab to rescan.";

  ALL_URLS = [];
  FILTERED_URLS = [];
  PAGE_INDEX = 0;
  renderBasic();
  renderAdvanced([]);
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
