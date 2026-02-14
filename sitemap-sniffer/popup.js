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
    // Some entries might be malformed—skip safely
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }

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

  // Sort types by count desc
  const sortedTypes = Object.entries(types).sort((a, b) => b[1] - a[1]);

  // Sort depths numerically asc
  const sortedDepths = Object.entries(depths).sort((a, b) => Number(a[0]) - Number(b[0]));

  statsEl.innerHTML = `
    <div class="stat">Total URLs: ${urls.length}</div>
    <div class="stat">Canonical Pages: ${canonicalCount}</div>
    <div class="stat" style="margin-top:8px;">By Type:</div>
    ${sortedTypes
      .map(([k, v]) => `<div class="stat">${k}: ${v}</div>`)
      .join("")}
  `;

  depthEl.innerHTML = `
    <div class="stat" style="margin-top:10px;">Depth Distribution:</div>
    ${sortedDepths
      .map(([k, v]) => `<div class="stat">Depth ${k}: ${v}</div>`)
      .join("")}
  `;
}

/* -------------------------
   POPUP BOOT
------------------------- */

async function run() {
  const siteEl = document.getElementById("site");
  const metaEl = document.getElementById("meta");
  const urlsEl = document.getElementById("urls");
  const detailEl = document.getElementById("detail");

  const origin = await getActiveTabOrigin();
  if (!origin) {
    if (siteEl) siteEl.textContent = "Sitemap";
    if (metaEl) metaEl.textContent = "Open a normal website tab (http/https).";
    if (urlsEl) urlsEl.value = "";
    if (detailEl) detailEl.textContent = "";
    renderAdvanced([]);
    return;
  }

  if (siteEl) siteEl.textContent = origin;

  const key = originKey(origin);
  const data = await chrome.storage.local.get(key);
  const rec = data?.[key];

  if (!rec) {
    if (metaEl) metaEl.textContent = "No data yet. Reload the page once.";
    if (urlsEl) urlsEl.value = "";
    if (detailEl) detailEl.textContent = "";
    renderAdvanced([]);
    return;
  }

  if (metaEl) {
    metaEl.textContent = rec.found
      ? `Found • ${rec.urlCount} URLs`
      : `No sitemap found (cached)`;
  }

  const urlList = Array.isArray(rec.urls) ? rec.urls : [];
  if (urlsEl) urlsEl.value = urlList.join("\n");

  // Render the Advanced tab analysis
  renderAdvanced(urlList);

  const scanned = rec.scannedAt ? new Date(rec.scannedAt).toLocaleString() : "unknown";
  const sitemap = rec.sitemapUrl ? rec.sitemapUrl : "none";

  if (detailEl) {
    detailEl.innerHTML =
      `Scanned: <b>${scanned}</b><br>` +
      `Sitemap: ${rec.sitemapUrl ? `<a href="${sitemap}" target="_blank">${sitemap}</a>` : "<b>none</b>"}`;
  }
}

/* -------------------------
   BUTTONS
------------------------- */

document.getElementById("copy")?.addEventListener("click", async () => {
  const text = document.getElementById("urls")?.value || "";
  await navigator.clipboard.writeText(text);
});

document.getElementById("refresh")?.addEventListener("click", async () => {
  const origin = await getActiveTabOrigin();
  if (!origin) return;
  await chrome.storage.local.remove(originKey(origin));
  const metaEl = document.getElementById("meta");
  if (metaEl) metaEl.textContent = "Cache cleared. Reload the tab to rescan.";
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