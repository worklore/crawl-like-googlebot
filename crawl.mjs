// Walks a site the way Googlebot does and reports what it could and could not see.
//
//   node crawl.mjs --site https://your-site.example [--out DIR] [--max 600] [--concurrency 3]
//     [--skip REGEX] [--analytics host,host] [--shots /,/some/page]
//
// Crawl only sites you own: it sends Googlebot's user agent and runs a real browser.
//
// Built on Crawlee (https://github.com/apify/crawlee) with Playwright, and
// robots-parser for the robots.txt rules. Each rule below comes from Google's
// own documentation, except the ones marked ASSUMED, which Google doesn't publish:
//
//   Starts at the home page and follows only <a href> links. Sitemap URLs that
//     links never reach are fetched afterwards and marked sitemap-only.
//     https://developers.google.com/search/docs/crawling-indexing/links-crawlable
//   Every URL is seen twice: the raw HTML, then the page after JavaScript. Links
//     are collected from both.
//     https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
//   Smartphone user agent (most crawl requests use the mobile crawler).
//     https://developers.google.com/search/docs/crawling-indexing/googlebot
//   Only the first 2MB of a URL counts, headers included.
//   The renderer requests JS, CSS and XHR, but not images, video or fonts.
//   robots.txt applies to those requests too: a blocked API call simply fails.
//     https://developers.google.com/search/blog/2026/03/crawler-blog-post
//   Nothing is kept between pages: cookies and storage start empty on each load.
//   Permissions are declined. Only HTTP works, so no WebSockets.
//     https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript
//   Pacific time, as when crawling from the US.
//     https://developers.google.com/search/docs/crawling-indexing/googlebot
//   ASSUMED: no clicks and no scrolling; a 412x732 viewport, then a tall one
//     before the DOM is read.
//   ASSUMED: rendering waits until the network is quiet, up to 15 seconds.
//     Google's real wait isn't published.
//
// Protecting production data, where this differs from Googlebot on purpose:
//   Analytics requests are aborted. Add your own hosts with --analytics.
//   POST/PUT/PATCH/DELETE to any host are aborted and reported.
//   URLs matching --skip are never fetched: use it for GETs that count something,
//     such as a download counter.
//   Page views still land in your server logs, so filter this crawler out of them.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { PlaywrightCrawler, Configuration, log, LogLevel } from "crawlee";
import robotsParser from "robots-parser";
import * as cheerio from "cheerio";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
if (!arg("site")) {
  console.error("Usage: node crawl.mjs --site https://your-site.example [--out DIR] [--max 600] [--concurrency 3] " +
    "[--skip REGEX] [--analytics host,host] [--shots /,/some/page]");
  process.exit(2);
}
const SITE = arg("site").replace(/\/$/, "");
const ORIGIN = new URL(SITE).origin;
const OUT = path.resolve(arg("out", `crawl-${new Date().toISOString().slice(0, 10)}`));
const MAX = Number(arg("max", 600));
const CONCURRENCY = Number(arg("concurrency", 3));
const TWO_MB = 2 * 1024 * 1024;
const QUIET_TIMEOUT = 15000;
const UA = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36 " +
  "(compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const ANALYTICS_HOSTS = ["plausible.io", "google-analytics.com", "googletagmanager.com", "segment.com", "segment.io",
  "posthog.com", "mixpanel.com", "amplitude.com", "hotjar.com", "clarity.ms",
  ...arg("analytics", "").split(",").map((h) => h.trim()).filter(Boolean)];
const isAnalytics = (host) => ANALYTICS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
const SKIP = arg("skip") ? new RegExp(arg("skip")) : null;
const SHOTS = arg("shots", "/").split(",");

fs.mkdirSync(OUT, { recursive: true });
log.setLevel(LogLevel.WARNING);

const pages = new Map();        // url -> everything seen about it
const edges = [];               // {from, to, text, stage: raw|rendered, nofollow}
const seen = new Set();
const blockedLinks = new Map(); // robots-disallowed link target -> sources
const skipped = new Set();

const page_ = (url) => {
  if (!pages.has(url)) pages.set(url, { url, via: "link", depth: null });
  return pages.get(url);
};

function normalize(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.href;
  } catch { return null; }
}

const textHash = (t) => crypto.createHash("sha1").update(t).digest("hex").slice(0, 12);
const squeeze = (t) => (t || "").replace(/\s+/g, " ").trim();
const words = (t) => (squeeze(t).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

function readRaw(html, url) {
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, el) => {
    const n = normalize($(el).attr("href"), url);
    if (n) links.push({ url: n, text: squeeze($(el).text()).slice(0, 80),
      nofollow: /nofollow/i.test($(el).attr("rel") || "") });
  });
  const title = squeeze($("title").first().text());
  const robots = $('meta[name="robots" i], meta[name="googlebot" i]').map((_, e) => $(e).attr("content")).get().join(", ");
  const canonical = $('link[rel="canonical"]').attr("href") || "";
  const description = $('meta[name="description" i]').attr("content") || "";
  const h1 = $("h1").map((_, e) => squeeze($(e).text())).get();
  $("script,style,noscript,template").remove();
  const text = squeeze($("body").text());
  return { title, robots, canonical, description, h1, words: words(text), chars: text.length, textHash: textHash(text), links };
}

// Runs in the page, before any of its own scripts.
const TIMELINE = () => {
  const tl = [];
  window.__timeline = tl;
  let last = 0;
  const snap = (force) => {
    const now = performance.now();
    if (!document.body || (!force && now - last < 40)) return;
    last = now;
    // parsing: the HTML is still arriving, so low counts here mean nothing yet.
    tl.push({ t: Math.round(now), links: document.links.length,
      text: (document.body.textContent || "").length, parsing: document.readyState === "loading" });
  };
  new MutationObserver(() => snap()).observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", () => snap(true));
  addEventListener("load", () => snap(true));
};

// Runs in the page, after rendering.
const READ_DOM = () => {
  const links = [...document.querySelectorAll("a[href]")].map((a) => ({
    href: a.getAttribute("href"),
    text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    nofollow: /nofollow/i.test(a.rel || ""),
  }));
  const meta = (sel) => [...document.querySelectorAll(sel)].map((m) => m.content).join(", ");
  return {
    title: document.title,
    robots: meta('meta[name="robots" i], meta[name="googlebot" i]'),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
    description: document.querySelector('meta[name="description" i]')?.content || "",
    h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent || "").replace(/\s+/g, " ").trim()),
    text: document.body ? document.body.innerText : "",
    links,
    // Things a person can click that Googlebot can't follow.
    notLinks: {
      // Elements that carry a destination in a data attribute instead of a link.
      targets: [...document.querySelectorAll("[data-nav],[data-href],[data-url],[data-link]")]
        .filter((e) => !e.matches("a[href]"))
        .map((e) => e.dataset.nav || e.dataset.href || e.dataset.url || e.dataset.link),
      roleLink: document.querySelectorAll('[role="link"]:not(a[href])').length,
      anchorsWithoutHref: document.querySelectorAll("a:not([href])").length,
      onclickElements: document.querySelectorAll("[onclick]:not(a[href])").length,
      fragmentOnly: [...document.querySelectorAll('a[href^="#"]')].length,
    },
    timeline: window.__timeline || [],
  };
};

async function fetchRaw(url) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "manual",
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*", "Accept-Encoding": "gzip, br" } });
  const buf = Buffer.from(await res.arrayBuffer());
  const headerBytes = [...res.headers].reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
  return {
    status: res.status,
    location: res.headers.get("location") || "",
    contentType: res.headers.get("content-type") || "",
    xRobots: res.headers.get("x-robots-tag") || "",
    cache: res.headers.get("x-cache") || "",
    bytes: buf.length + headerBytes,
    overTwoMb: buf.length + headerBytes > TWO_MB,
    ms: Date.now() - started,
    body: buf.subarray(0, TWO_MB).toString("utf8"),
  };
}

// ---- robots.txt, sitemap ----------------------------------------------------

// No robots.txt means everything is allowed, and a site's 404 page isn't a set of rules.
const robotsRes = await fetch(`${ORIGIN}/robots.txt`, { headers: { "User-Agent": UA } });
const robotsTxt = robotsRes.ok ? await robotsRes.text() : "";
const robots = robotsParser(`${ORIGIN}/robots.txt`, robotsTxt);
const allowed = (url) => robots.isAllowed(url, "Googlebot") !== false;

async function readSitemap(url, out = new Map()) {
  const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
  if (!res?.ok) return out;
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  for (const el of $("sitemap > loc").toArray()) await readSitemap($(el).text().trim(), out);
  $("url").each((_, el) => out.set($(el).find("loc").text().trim(), $(el).find("lastmod").text().trim()));
  return out;
}
const sitemapUrl = robots.getSitemaps()[0] || `${ORIGIN}/sitemap.xml`;
const sitemap = await readSitemap(sitemapUrl);

// ---- the crawl --------------------------------------------------------------

const config = new Configuration({ persistStorage: false, purgeOnStart: true,
  storageClientOptions: { localDataDirectory: path.join(OUT, ".storage") } });

function discover(from, links, stage, depth) {
  const queue = [];
  for (const l of links) {
    edges.push({ from, to: l.url, text: l.text, stage, nofollow: !!l.nofollow });
    if (!l.url.startsWith(ORIGIN + "/") && l.url !== ORIGIN) continue;
    if (SKIP?.test(l.url)) { skipped.add(l.url); continue; }
    if (!allowed(l.url)) {
      if (!blockedLinks.has(l.url)) blockedLinks.set(l.url, new Set());
      blockedLinks.get(l.url).add(from);
      continue;
    }
    const known = pages.get(l.url);
    if (known && (known.depth === null || known.depth > depth + 1)) known.depth = depth + 1;
    if (seen.has(l.url) || seen.size >= MAX) continue;
    seen.add(l.url);
    page_(l.url).depth = depth + 1;
    queue.push({ url: l.url, uniqueKey: l.url, userData: { depth: depth + 1 } });
  }
  return queue;
}

const makeCrawler = () => new PlaywrightCrawler({
  launchContext: { launcher: chromium, useIncognitoPages: true, launchOptions: { headless: true } },
  browserPoolOptions: {
    useFingerprints: false,
    prePageCreateHooks: [(_id, _ctrl, opts) => Object.assign(opts, {
      userAgent: UA, viewport: { width: 412, height: 732 }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 1, serviceWorkers: "block", timezoneId: "America/Los_Angeles",
    })],
  },
  useSessionPool: false,
  persistCookiesPerSession: false,
  maxConcurrency: CONCURRENCY,
  maxRequestsPerMinute: 120,
  maxRequestRetries: 1,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 90,
  preNavigationHooks: [async ({ request, page }) => {
    const rec = page_(request.url);
    const raw = await fetchRaw(request.url);
    const { body, ...head } = raw;
    rec.raw = head;
    const isHtml = /html/i.test(raw.contentType);
    if (raw.status === 200 && isHtml) {
      const parsed = readRaw(body, request.url);
      rec.raw = { ...head, ...parsed };
    }
    // Google won't render a page whose raw HTML says noindex, or isn't a 200.
    const rawNoindex = /noindex/i.test(`${rec.raw.robots || ""} ${raw.xRobots}`);
    if (raw.status !== 200 || !isHtml || rawNoindex) {
      request.skipNavigation = true;
      rec.rendered = null;
      rec.renderSkipped = raw.status !== 200 ? `status ${raw.status}` : !isHtml ? "not html" : "noindex in raw html";
      return;
    }
    rec.requests = { made: [], robotsBlocked: [], analyticsAborted: [], writesAborted: [], mediaAborted: 0,
      failed: [], consoleErrors: [], pageErrors: [] };
    const r = rec.requests;
    page.on("console", (m) => { if (m.type() === "error") r.consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => r.pageErrors.push(String(e).slice(0, 200)));
    page.on("response", (res) => {
      if (res.status() >= 400) r.failed.push({ url: res.url(), status: res.status() });
    });
    await page.addInitScript(TIMELINE);
    await page.route("**/*", (route) => {
      const q = route.request();
      const u = new URL(q.url());
      const type = q.resourceType();
      if (["image", "media", "font"].includes(type)) { r.mediaAborted++; return route.abort(); }
      if (isAnalytics(u.hostname)) { r.analyticsAborted.push(q.url()); return route.abort(); }
      if (!["GET", "HEAD"].includes(q.method())) {
        r.writesAborted.push(`${q.method()} ${u.origin === ORIGIN ? u.pathname : u.origin + u.pathname}`);
        return route.abort();
      }
      if (u.origin === ORIGIN && !allowed(q.url())) {
        r.robotsBlocked.push(`${q.method()} ${u.pathname}`);
        return route.abort();
      }
      r.made.push({ url: q.url(), type });
      return route.continue();
    });
  }],
  async requestHandler({ request, page, crawler: c }) {
    const rec = page_(request.url);
    // 1000+ means no chain of links from the home page reaches this page.
    const depth = request.userData.depth ?? rec.depth ?? 1000;
    const add = async (links, stage) => {
      const q = discover(request.url, links, stage, depth);
      if (q.length) await c.addRequests(q);
    };

    if (rec.raw?.location) {
      const target = normalize(rec.raw.location, request.url);
      if (target) await add([{ url: target, text: "(redirect)" }], "raw");
    }
    await add(rec.raw?.links || [], "raw");
    if (request.skipNavigation) return;

    const t0 = Date.now();
    let quiet = true;
    await page.waitForLoadState("networkidle", { timeout: QUIET_TIMEOUT }).catch(() => { quiet = false; });
    await page.setViewportSize({ width: 412, height: 9000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    const dom = await page.evaluate(READ_DOM);
    const links = dom.links.map((l) => ({ url: normalize(l.href, request.url), text: l.text, nofollow: l.nofollow }))
      .filter((l) => l.url);
    const text = squeeze(dom.text);
    rec.rendered = {
      title: dom.title, robots: dom.robots, canonical: dom.canonical, description: dom.description, h1: dom.h1,
      words: words(text), textHash: textHash(text), links, notLinks: dom.notLinks, networkQuiet: quiet,
      waitedMs: Date.now() - t0, timeline: dom.timeline, textSample: text.slice(0, 300),
    };
    await add(links, "rendered");

    const slug = new URL(request.url).pathname.replace(/\W+/g, "_") || "_";
    if (SHOTS.includes(new URL(request.url).pathname)) {
      await page.screenshot({ path: path.join(OUT, `render${slug}.png`) }).catch(() => {});
    }
  },
  failedRequestHandler({ request, error }) {
    page_(request.url).crawlError = String(error?.message || request.errorMessages?.[0]).slice(0, 300);
  },
}, config);

const homeUrl = `${ORIGIN}/`;
seen.add(homeUrl);
page_(homeUrl).depth = 0;
await makeCrawler().run([{ url: homeUrl, uniqueKey: homeUrl, userData: { depth: 0 } }]);

// Sitemap URLs that no link reached: what Google learns only from the sitemap.
const sitemapOnly = [...sitemap.keys()].filter((u) => !seen.has(u) && allowed(u));
for (const u of sitemapOnly) { seen.add(u); page_(u).via = "sitemap"; }
// A second crawler, because the first one closes its browser when its queue is empty.
if (sitemapOnly.length) {
  await makeCrawler().run(sitemapOnly.map((u) => ({ url: u, uniqueKey: u, userData: { depth: null } })));
}

fs.writeFileSync(path.join(OUT, "crawl.json"), JSON.stringify({
  site: SITE, finishedAt: new Date().toISOString(), userAgent: UA, robotsTxt,
  sitemap: Object.fromEntries(sitemap), sitemapOnly,
  sitemapBlockedByRobots: [...sitemap.keys()].filter((u) => !allowed(u)),
  blockedLinks: Object.fromEntries([...blockedLinks].map(([k, v]) => [k, [...v]])),
  skipped: [...skipped],
  pages: [...pages.values()],
  edges,
}, null, 1));
console.log(`crawled ${pages.size} urls, ${edges.length} links -> ${path.join(OUT, "crawl.json")}`);
fs.rmSync(path.join(OUT, ".storage"), { recursive: true, force: true });
