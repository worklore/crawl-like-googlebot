#!/usr/bin/env python3
"""Turns crawl.json into report.md: what a Googlebot-like crawler saw on the site.

    python3 analyze.py CRAWL_DIR [--types "/blog/=post,/tag/=tag"] [--content post] [--gsc coverage.json]

--types    names page types by path prefix. Without it, a page's type is the first
           part of its path: /blog/hello is "blog".
--content  the type that holds your real content, used for "links from content
           pages". Without it, the type with the most pages.
--gsc      coverage.json: {url: "the Search Console coverage text"}. With it the
           report compares what the crawler measured against what Google actually
           decided, which is the check that this crawl means anything.
"""
import collections
import json
import pathlib
import re
import statistics
import sys
from urllib.parse import urlsplit

args = sys.argv[1:]
if not args or args[0].startswith("-"):
    sys.exit(__doc__)
out = pathlib.Path(args[0])


def opt(name):
    return args[args.index(name) + 1] if name in args else None


gsc = json.load(open(opt("--gsc"))) if opt("--gsc") else {}
TYPES = [tuple(x.split("=", 1)) for x in (opt("--types") or "").split(",") if "=" in x]
d = json.load(open(out / "crawl.json"))
pages = {p["url"]: p for p in d["pages"]}
site = d["site"]
sitemap = d["sitemap"]


def path(u):
    return u.replace(site, "") or "/"


def kind(u):
    p = urlsplit(u).path
    for pre, name in TYPES:
        if p.startswith(pre):
            return name
    if p == "/":
        return "home"
    parts = p.strip("/").split("/")
    return parts[0] if len(parts) > 1 else "other"


def is_html_ok(p):
    return (p.get("raw") or {}).get("status") == 200 and "html" in (p.get("raw") or {}).get("contentType", "")


html_pages = [p for p in pages.values() if is_html_ok(p)]
_content = collections.Counter(kind(p["url"]) for p in html_pages if kind(p["url"]) not in ("home", "other"))
CONTENT = opt("--content") or (_content.most_common(1)[0][0] if _content else "other")


def noindex(p):
    r, x = p.get("raw") or {}, p.get("rendered") or {}
    return "noindex" in f'{r.get("robots","")} {r.get("xRobots","")} {x.get("robots","")}'.lower()


def canonical_of(p):
    x = p.get("rendered") or p.get("raw") or {}
    return x.get("canonical", "")


def same_url(a, b):
    return a.rstrip("/") == b.rstrip("/")


# ---- links ------------------------------------------------------------------
inbound = collections.defaultdict(set)         # target -> sources, any stage
inbound_raw = collections.defaultdict(set)     # target -> sources, in the raw HTML
inbound_rendered = collections.defaultdict(set)
anchors = collections.defaultdict(collections.Counter)
for e in d["edges"]:
    if e["from"] == e["to"]:
        continue
    inbound[e["to"]].add(e["from"])
    (inbound_raw if e["stage"] == "raw" else inbound_rendered)[e["to"]].add(e["from"])
    if e.get("text"):
        anchors[e["to"]][e["text"]] += 1


def from_kind(u, k):
    return sum(1 for s in inbound[u] if kind(s) == k)


L = []
w = L.append
w(f"# What a Googlebot-like crawler sees on {site}\n")
w(f"Finished {d['finishedAt']}. {len(pages)} URLs fetched, {len(html_pages)} of them HTML pages with status 200, "
  f"{len(d['edges'])} links read. Sitemap lists {len(sitemap)} URLs.\n")

# ---- reach ------------------------------------------------------------------
w("## Can the crawler get there?\n")
by_kind = collections.Counter(kind(p["url"]) for p in html_pages)
w("Pages by type: " + ", ".join(f"{k} {v}" for k, v in by_kind.most_common()) + "\n")
depths = collections.Counter(p["depth"] if (p.get("depth") if p.get("depth") is not None else 1000) < 1000 else "not reachable by links"
                             for p in html_pages)
w("Clicks from the home page: " + ", ".join(f"{k}: {v}" for k, v in sorted(depths.items(), key=lambda x: str(x[0]))) + "\n")
via_sitemap = [p["url"] for p in pages.values() if p.get("via") == "sitemap"]
w(f"Reachable only through the sitemap, no link leads there: {len(via_sitemap)}")
for u in via_sitemap[:40]:
    w(f"- {path(u)}")
w("")
status = collections.Counter((p.get("raw") or {}).get("status") for p in pages.values())
w("Status codes: " + ", ".join(f"{k}: {v}" for k, v in status.most_common()) + "\n")
for code in sorted(c for c in status if c and c >= 300):
    us = [p["url"] for p in pages.values() if (p.get("raw") or {}).get("status") == code]
    w(f"{code}:")
    for u in us[:25]:
        w(f"- {path(u)} {(pages[u]['raw'].get('location') or '')}  (linked from {len(inbound[u])} pages, e.g. "
          f"{', '.join(path(s) for s in list(inbound[u])[:2])})")
    w("")
errs = [p for p in pages.values() if p.get("crawlError")]
w(f"Pages the crawler failed on: {len(errs)}")
for p in errs[:15]:
    w(f"- {path(p['url'])}: {p['crawlError'][:160]}")
w("")
w(f"Links to URLs robots.txt forbids: {len(d['blockedLinks'])} targets")
for u, s in list(d["blockedLinks"].items())[:15]:
    w(f"- {path(u)} (from {len(s)} pages)")
w("")

# ---- raw vs rendered --------------------------------------------------------
w("## What changes when JavaScript runs?\n")
rend = [p for p in html_pages if p.get("rendered")]
w(f"Rendered {len(rend)} pages.\n")
rows = collections.defaultdict(list)
for p in rend:
    r, x = p["raw"], p["rendered"]
    rl = {l["url"] for l in r.get("links", [])}
    xl = {l["url"] for l in x.get("links", [])}
    rows[kind(p["url"])].append({
        "url": p["url"], "raw_links": len(rl), "rend_links": len(xl), "lost": rl - xl, "added": xl - rl,
        "raw_words": r.get("words", 0), "rend_words": x.get("words", 0),
    })
w("| page type | pages | words raw | words rendered | links raw | links rendered | links lost per page | links added per page |")
w("|---|---|---|---|---|---|---|---|")
med = lambda xs: round(statistics.median(xs)) if xs else 0
for k, rs in sorted(rows.items()):
    w(f"| {k} | {len(rs)} | {med([x['raw_words'] for x in rs])} | {med([x['rend_words'] for x in rs])} | "
      f"{med([x['raw_links'] for x in rs])} | {med([x['rend_links'] for x in rs])} | "
      f"{med([len(x['lost']) for x in rs])} | {med([len(x['added']) for x in rs])} |")
w("")
w("Medians. A link lost means it is in the HTML the server sent and gone from the page after JavaScript.\n")

allr = [x for rs in rows.values() for x in rs]
lost_kinds = collections.Counter(kind(u) for x in allr for u in x["lost"])
added_kinds = collections.Counter(kind(u) for x in allr for u in x["added"])
w("Lost links point at: " + (", ".join(f"{k} {v}" for k, v in lost_kinds.most_common()) or "nothing") + "")
w("Added links point at: " + (", ".join(f"{k} {v}" for k, v in added_kinds.most_common()) or "nothing") + "\n")
w("Pages that lose the most links:")
for x in sorted(allr, key=lambda x: -len(x["lost"]))[:10]:
    w(f"- {path(x['url'])}: {x['raw_links']} -> {x['rend_links']}, lost {len(x['lost'])}, e.g. "
      f"{', '.join(path(u) for u in list(x['lost'])[:4])}")
w("")

changed = collections.defaultdict(list)
for p in rend:
    r, x = p["raw"], p["rendered"]
    if r.get("title") != x.get("title"):
        changed["title"].append((p["url"], r.get("title"), x.get("title")))
    if not same_url(r.get("canonical", ""), x.get("canonical", "")):
        changed["canonical"].append((p["url"], r.get("canonical"), x.get("canonical")))
    if r.get("description") != x.get("description"):
        changed["description"].append((p["url"], r.get("description", "")[:60], x.get("description", "")[:60]))
    if r.get("robots") != x.get("robots"):
        changed["robots meta"].append((p["url"], r.get("robots"), x.get("robots")))
    if r.get("h1") != x.get("h1"):
        changed["h1"].append((p["url"], r.get("h1"), x.get("h1")))
w("Head tags and h1 that differ between raw HTML and rendered page:\n")
for k in ("title", "canonical", "description", "robots meta", "h1"):
    w(f"- {k}: {len(changed[k])} pages")
    for row in changed[k][:4]:
        w(f"  - {path(row[0])}: `{row[1]}` -> `{row[2]}`")
w("")

# ---- the wipe ---------------------------------------------------------------
w("## Does the page empty itself before filling up again?\n")
wiped = []
for p in rend:
    tl = p["rendered"].get("timeline") or []
    if not tl:
        continue
    # A page counts as emptied when, with its HTML fully arrived, its text or links
    # stand at less than half of what the server sent or the page already showed.
    # Samples taken while the HTML is still arriving are low for no bad reason.
    settled = [i for i, t in enumerate(tl) if not t.get("parsing")]
    if not settled:
        continue
    low_i = min(settled, key=lambda i: tl[i].get("text", 0))
    peak_text = max([p["raw"].get("chars", 0)] + [t.get("text", 0) for t in tl[: low_i + 1]])
    low_text = tl[low_i].get("text", 0)
    link_low_i = min(settled, key=lambda i: tl[i]["links"])
    peak_links = max([len(p["raw"].get("links", []))] + [t["links"] for t in tl[: link_low_i + 1]])
    low_links = tl[link_low_i]["links"]
    target = min(peak_text, tl[-1].get("text", 0)) * 0.9
    back_t = next((t["t"] for t in tl[low_i + 1:] if t.get("text", 0) >= target), None)
    wiped.append({"url": p["url"], "peak_links": peak_links, "low_links": low_links,
                  "final": len(p["rendered"].get("links", [])),
                  "peak_text": peak_text, "low_text": low_text, "low_t": tl[low_i]["t"], "back_t": back_t,
                  "text_gone": peak_text >= 500 and low_text < peak_text * 0.5,
                  "links_gone": peak_links >= 5 and low_links < peak_links * 0.5})
gone = [x for x in wiped if x["text_gone"] or x["links_gone"]]
w(f"{len(gone)} of {len(wiped)} pages lose more than half of their text or links during load: "
  f"text on {sum(x['text_gone'] for x in gone)}, links on {sum(x['links_gone'] for x in gone)}.\n")
if gone:
    w("| page | text before | text at lowest | at ms | back at ms | links before | lowest links | final links |")
    w("|---|---|---|---|---|---|---|---|")
    for x in sorted(gone, key=lambda x: -x["peak_text"])[:12]:
        w(f"| {path(x['url'])} | {x['peak_text']} | {x['low_text']} | {x['low_t']} | {x['back_t']} "
          f"| {x['peak_links']} | {x['low_links']} | {x['final']} |")
w("")

# ---- what the renderer could not do -----------------------------------------
w("## What failed while rendering?\n")
reqs = [p for p in rend if p.get("requests")]
slug = lambda t: re.sub(r"/[^/ ?]{24,}", "/{slug}", t)  # groups requests that differ only by a long id
blocked = collections.Counter(slug(b)
                              for p in reqs for b in p["requests"]["robotsBlocked"])
w(f"Requests robots.txt blocks: {sum(blocked.values())}")
for k, v in blocked.most_common(15):
    w(f"- {k}: {v}")
w("")
writes = collections.Counter(slug(b)
                             for p in reqs for b in p["requests"]["writesAborted"])
w(f"Write requests a page makes on load, stopped by the crawler: {sum(writes.values())}")
for k, v in writes.most_common(10):
    w(f"- {k}: {v}")
w("")
failed = collections.Counter(f'{f["status"]} {slug(path(f["url"]))}'
                             for p in reqs for f in p["requests"]["failed"])
w(f"Requests answered with an error: {sum(failed.values())}")
for k, v in failed.most_common(15):
    w(f"- {k}: {v}")
w("")
perr = collections.Counter(e for p in reqs for e in p["requests"]["pageErrors"])
w(f"JavaScript exceptions: {sum(perr.values())}")
for k, v in perr.most_common(8):
    w(f"- {k}: {v}")
w("")
notquiet = [p["url"] for p in rend if not p["rendered"].get("networkQuiet")]
w(f"Pages whose network never went quiet within the wait: {len(notquiet)}")
for u in notquiet[:10]:
    w(f"- {path(u)}")
w("")
third = collections.Counter(urlsplit(m["url"]).hostname for p in reqs for m in p["requests"]["made"]
                            if not m["url"].startswith(site))
w("Other hosts pages need while rendering: " + (", ".join(f"{k} ({v})" for k, v in third.most_common()) or "none") + "\n")
big = sorted(html_pages, key=lambda p: -p["raw"].get("bytes", 0))[:5]
w("Largest pages: " + ", ".join(f"{path(p['url'])} {p['raw']['bytes']//1024} KB" for p in big)
  + f". Over the 2 MB limit: {sum(1 for p in html_pages if p['raw'].get('overTwoMb'))}.\n")
slow = sorted(html_pages, key=lambda p: -p["raw"].get("ms", 0))[:3]
w("Slowest server responses: " + ", ".join(f"{path(p['url'])} {p['raw']['ms']} ms" for p in slow)
  + f". Median {med([p['raw'].get('ms', 0) for p in html_pages])} ms.\n")

# ---- sitemap vs reality -----------------------------------------------------
w("## Does the sitemap agree with the pages?\n")
sm_bad = collections.defaultdict(list)
for u in sitemap:
    p = pages.get(u)
    if not p:
        sm_bad["never fetched"].append(u)
        continue
    if not is_html_ok(p):
        sm_bad[f"status {(p.get('raw') or {}).get('status')}"].append(u)
        continue
    if noindex(p):
        sm_bad["noindex"].append(u)
    c = canonical_of(p)
    if not c:
        sm_bad["no canonical"].append(u)
    elif not same_url(c, u):
        sm_bad["canonical points elsewhere"].append(f"{u} -> {c}")
    if c and c != u and same_url(c, u):
        sm_bad["canonical differs by a slash"].append(f"{u} -> {c}")
for k, v in sm_bad.items():
    w(f"- In the sitemap but {k}: {len(v)}")
    for u in v[:12]:
        w(f"  - {u.replace(site, '')}")
if not sm_bad:
    w("- Every sitemap URL is a 200, indexable, and its own canonical.")
missing = [p["url"] for p in html_pages if p["url"] not in sitemap and not noindex(p) and same_url(canonical_of(p), p["url"])]
w(f"- Indexable pages missing from the sitemap: {len(missing)}")
for u in missing[:25]:
    w(f"  - {path(u)} (linked from {len(inbound[u])} pages)")
w(f"- Sitemap entries with a lastmod: {sum(1 for v in sitemap.values() if v)} of {len(sitemap)}")
w("")

# ---- internal links ---------------------------------------------------------
w("## How well linked is each page type?\n")
w(f"| page type | pages | median pages linking in | fewest | most | from {CONTENT} pages (median) | in raw HTML (median) |")
w("|---|---|---|---|---|---|---|")
groups = collections.defaultdict(list)
for p in html_pages:
    if not noindex(p):
        groups[kind(p["url"])].append(p["url"])
for k, us in sorted(groups.items()):
    ns = [len(inbound[u]) for u in us]
    w(f"| {k} | {len(us)} | {med(ns)} | {min(ns)} | {max(ns)} | {med([from_kind(u, CONTENT) for u in us])} | "
      f"{med([len(inbound_raw[u]) for u in us])} |")
w("")
few = sorted((p for p in html_pages if not noindex(p)), key=lambda p: len(inbound[p["url"]]))[:15]
w("Least linked indexable pages:")
for p in few:
    w(f"- {path(p['url'])}: {len(inbound[p['url']])} ({', '.join(path(s) for s in list(inbound[p['url']])[:3])})")
w("")
nl = collections.Counter(kind(site + t) if t.startswith("/") else t
                         for p in rend for t in p["rendered"]["notLinks"]["targets"] if t)
w("Clickable for a person, but not a link Google can follow, by the type of page they lead to:")
for k, v in nl.most_common(15):
    w(f"- {k}: {v} elements")
w(f"- `role=\"link\"` without a real link: {sum(p['rendered']['notLinks']['roleLink'] for p in rend)}")
w(f"- `<a>` without href: {sum(p['rendered']['notLinks']['anchorsWithoutHref'] for p in rend)}")
w(f"- `onclick` elements: {sum(p['rendered']['notLinks']['onclickElements'] for p in rend)}")
w("")

# ---- duplicates, thin -------------------------------------------------------
w("## Duplicates and thin pages, as rendered\n")
indexable = [p for p in html_pages if not noindex(p) and p.get("rendered")]
for field, label in (("title", "title"), ("description", "description"), ("textHash", "body text")):
    c = collections.defaultdict(list)
    for p in indexable:
        c[p["rendered"].get(field) or "(empty)"].append(p["url"])
    dup = {k: v for k, v in c.items() if len(v) > 1}
    w(f"- Same {label} on several pages: {sum(len(v) for v in dup.values())} pages in {len(dup)} groups")
    for k, v in sorted(dup.items(), key=lambda x: -len(x[1]))[:4]:
        w(f"  - `{k[:70]}`: {', '.join(path(u) for u in v[:5])}")
nohd = [p["url"] for p in indexable if not p["rendered"].get("h1")]
w(f"- No h1 after rendering: {len(nohd)} {[path(u) for u in nohd[:8]]}")
w("")
w("| page type | median words rendered | under 150 words | under 300 words |")
w("|---|---|---|---|")
tw = collections.defaultdict(list)
for p in indexable:
    tw[kind(p["url"])].append(p["rendered"]["words"])
for k, ns in sorted(tw.items()):
    w(f"| {k} | {med(ns)} | {sum(n < 150 for n in ns)} of {len(ns)} | {sum(n < 300 for n in ns)} of {len(ns)} |")
w("")

# ---- against Google ---------------------------------------------------------
if gsc:
    w("## Against what Google actually decided\n")
    st = collections.Counter(gsc.values())
    w("Search Console status of the URLs checked: " + ", ".join(f"{k}: {v}" for k, v in st.most_common()) + "\n")
    w(f"| Search Console status | pages | median pages linking in | median links from {CONTENT} pages | median depth | median words |")
    w("|---|---|---|---|---|---|")
    by = collections.defaultdict(list)
    for u, s in gsc.items():
        if u in pages:
            by[(kind(u), s)].append(u)
    for (k, s), us in sorted(by.items()):
        w(f"| {k}: {s} | {len(us)} | {med([len(inbound[u]) for u in us])} | {med([from_kind(u, CONTENT) for u in us])} | "
          f"{med([pages[u].get('depth') or 0 for u in us])} | "
          f"{med([(pages[u].get('rendered') or {}).get('words', 0) for u in us])} |")
    w("")

(out / "report.md").write_text("\n".join(L))
print("\n".join(L))
