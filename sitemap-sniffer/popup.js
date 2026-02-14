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

async function run() {
  const siteEl = document.getElementById("site");
  const metaEl = document.getElementById("meta");
  const urlsEl = document.getElementById("urls");
  const detailEl = document.getElementById("detail");

  const origin = await getActiveTabOrigin();
  if (!origin) {
    siteEl.textContent = "Sitemap";
    metaEl.textContent = "Open a normal website tab (http/https).";
    urlsEl.value = "";
    detailEl.textContent = "";
    return;
  }

  siteEl.textContent = origin;

  const key = originKey(origin);
  const data = await chrome.storage.local.get(key);
  const rec = data?.[key];

  if (!rec) {
    metaEl.textContent = "No data yet. Reload the page once.";
    urlsEl.value = "";
    detailEl.textContent = "";
    return;
  }

  metaEl.textContent = rec.found
    ? `Found • ${rec.urlCount} URLs`
    : `No sitemap found (cached)`;

  urlsEl.value = (rec.urls || []).join("\n");

  const scanned = rec.scannedAt ? new Date(rec.scannedAt).toLocaleString() : "unknown";
  const sitemap = rec.sitemapUrl ? rec.sitemapUrl : "none";

  detailEl.innerHTML =
    `Scanned: <b>${scanned}</b><br>` +
    `Sitemap: ${rec.sitemapUrl ? `<a href="${sitemap}" target="_blank">${sitemap}</a>` : "<b>none</b>"}`;
}

document.getElementById("copy").addEventListener("click", async () => {
  const text = document.getElementById("urls").value || "";
  await navigator.clipboard.writeText(text);
});

document.getElementById("refresh").addEventListener("click", async () => {
  const origin = await getActiveTabOrigin();
  if (!origin) return;
  // Force refresh by clearing cached record so next page load re-scans.
  await chrome.storage.local.remove(`sitemap:${origin}`);
  // Tell user to reload tab
  document.getElementById("meta").textContent = "Cache cleared. Reload the tab to rescan.";
});

run().catch(() => {});