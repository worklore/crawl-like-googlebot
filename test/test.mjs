// Runs the crawler against a tiny local site with known flaws, then checks the
// report names each one. Needs no network and touches no real site.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const writes = [];
const html = (title, body, head = "") =>
  `<!doctype html><html><head><title>${title}</title><link rel="canonical" href="BASE${title}">${head}</head><body>${body}</body></html>`;

// Empties itself, waits, then fills back up with buttons instead of links.
const wipe = `<script>
  const server = document.getElementById("app").innerHTML;
  document.getElementById("app").innerHTML = "<p>loading</p>";
  setTimeout(() => { document.getElementById("app").innerHTML =
    "<button data-nav='/posts/one'>one</button><button data-nav='/posts/two'>two</button>" + server.replace(/<a [^>]*>.*?<\\/a>/g, "") ; }, 300);
</script>`;
const filler = "<p>" + "Words the server sent for anyone to read. ".repeat(40) + "</p>";
const links = ["one", "two", "three", "four", "five", "six"].map((n) => `<a href="/posts/${n}">${n}</a>`).join(" ");

const pages = {
  "/": html("/", `<h1>Home</h1><a href="/list">list</a> <a href="/hidden">hidden</a> <a href="/blocked/page">blocked</a> <a href="/slow">slow</a>`),
  "/list": html("/list", `<h1>List</h1><div id="app">${links}${filler}</div>${wipe}`),
  "/hidden": html("/hidden", "<h1>Hidden</h1>", '<meta name="robots" content="noindex">'),
  "/posts/one": html("/posts/one", `<h1>One</h1>${filler}<script>fetch("/count", { method: "POST" }).catch(() => {});</script>`),
  "/posts/two": html("/posts/two", `<h1>Two</h1>${filler}`),
  "/posts/three": html("/posts/three", `<h1>Three</h1>${filler}`),
  "/posts/four": html("/posts/four", `<h1>Four</h1>${filler}<script>nope.nope();</script>`),
  "/posts/five": html("/posts/five", `<h1>Five</h1>${filler}`),
  "/posts/six": html("/posts/six", `<h1>Six</h1>${filler}`),
  "/orphan": html("/orphan", `<h1>Orphan</h1>${filler}`),
};

const server = http.createServer((q, r) => {
  const base = `http://localhost:${server.address().port}`;
  // HTML that arrives in two parts: few links at first is not a page emptying itself.
  if (q.url === "/slow") {
    r.writeHead(200, { "content-type": "text/html" });
    r.write(`<!doctype html><html><head><title>/slow</title><link rel="canonical" href="${base}/slow"></head><body><h1>Slow</h1><a href="/posts/one">one</a>`);
    return setTimeout(() => r.end(`${links} ${links}${filler}</body></html>`), 400);
  }
  if (q.method !== "GET" && q.method !== "HEAD") { writes.push(q.url); r.writeHead(204); return r.end(); }
  if (q.url === "/robots.txt") { r.writeHead(200, { "content-type": "text/plain" }); return r.end("User-agent: *\nDisallow: /blocked/\n"); }
  if (q.url === "/sitemap.xml") {
    r.writeHead(200, { "content-type": "application/xml" });
    return r.end(`<urlset><url><loc>${base}/</loc></url><url><loc>${base}/orphan</loc></url></urlset>`);
  }
  const body = pages[q.url];
  if (!body) { r.writeHead(404, { "content-type": "text/html" }); return r.end("not found"); }
  r.writeHead(200, { "content-type": "text/html" });
  r.end(body.replaceAll('href="BASE', `href="${base}`));
});
await new Promise((ok) => server.listen(0, ok));

const site = `http://localhost:${server.address().port}`;
const out = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-like-googlebot-"));

// The crawl needs this process's server running, so it can't use spawnSync.
const { spawn } = await import("node:child_process");
const code = await new Promise((ok) => {
  const c = spawn("node", [path.join(root, "crawl.mjs"), "--site", site, "--out", out, "--concurrency", "2"], { stdio: "inherit" });
  c.on("exit", ok);
});
server.close();
server.closeAllConnections?.();
if (code !== 0) { console.error(`crawl exited with ${code}`); process.exit(1); }

const a = spawnSync("python3", [path.join(root, "analyze.py"), out], { encoding: "utf8" });
if (a.status !== 0) { console.error(a.stderr); process.exit(1); }
const report = a.stdout;

const checks = [
  ["finds the page only the sitemap reaches", /no link leads there: 1\n- \/orphan/],
  ["names the links lost after JavaScript", /\/list: \d+ -> \d+, lost \d+/],
  ["sees the page empty itself", /1 of \d+ pages lose more than half[\s\S]*?\| \/list \|/],
  ["counts the buttons that are not links", /by the type of page they lead to:\n- posts: 2 elements/],
  ["stops the write and reports it", /stopped by the crawler: 1\n- POST \/count: 1/],
  ["reports the JavaScript exception", /JavaScript exceptions: 1/],
  ["respects robots.txt", /Links to URLs robots.txt forbids: 1 targets\n- \/blocked\/page/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(report);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}
if (writes.length) { failed++; console.log(`FAIL a write reached the server: ${writes.join(", ")}`); }
else console.log("ok   no write reached the server");
fs.rmSync(out, { recursive: true, force: true });
if (failed) { console.log(report); process.exit(1); }
console.log("all checks passed");
