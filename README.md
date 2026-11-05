# crawl-like-googlebot

**Walk your own site the way Googlebot does, and see what it could and could not reach.**

Reading your sitemap and your code tells you what you meant to publish. This shows what a crawler gets: it follows only real `<a href>` links, reads every page as the server sent it and again after JavaScript ran, and writes a plain report.

It was built after two months of failing to get [worklore.dev](https://worklore.dev) into Google search. The sitemap and the code looked fine. The first crawl found a home page sending most of its links to noindex pages, a listing page losing every story link once JavaScript ran, and pages that emptied themselves while loading.

## Quick start

Needs Node.js 18+ and Python 3. Crawl only sites you own: it sends Googlebot's user agent and runs a real browser.

```bash
git clone https://github.com/worklore/crawl-like-googlebot
cd crawl-like-googlebot
npm install
npx playwright install chromium
npm test        # runs against a small local site, touches nothing real

node crawl.mjs --site https://your-site.example --out crawl-mysite
python3 analyze.py crawl-mysite
```

The report is in `crawl-mysite/report.md`. The raw data is in `crawl.json` beside it.

## What the report answers

- **Can the crawler get there?** Depth from the home page, pages only the sitemap reaches, status codes, links that robots.txt forbids.
- **What changes when JavaScript runs?** Words and links before and after, per page type, and which links disappear.
- **Does the page empty itself while loading?** Comparing the first and last state hides this: a page can go from 278 links to 306 and look healthy while falling to 23 in between. So every page keeps a timeline of its links and text during the load.
- **What failed while rendering?** Requests robots.txt blocks, requests answered with an error, JavaScript exceptions, pages that never go quiet, other hosts a page depends on.
- **Does the sitemap agree with the pages?** Entries that are noindex, redirect or point their canonical elsewhere, and indexable pages missing from it.
- **How well linked is each page type?** Pages linking in, the least linked pages, and things a person can click that aren't links.
- **Duplicates and thin pages.** Same title, description or body text, a missing h1, low word counts.

## Options

`crawl.mjs`

| Option | Meaning | Default |
|---|---|---|
| `--site URL` | The site to crawl, starting at the root of its origin. Use the final address after any redirect. | required |
| `--out DIR` | Where to write the results | `crawl-<date>` |
| `--max N` | Stop discovering new URLs after this many | 600 |
| `--concurrency N` | Pages at a time | 3 |
| `--skip REGEX` | URLs never to fetch. Use it for GETs that count something. | none |
| `--analytics a.com,b.com` | More analytics hosts to block | common ones |
| `--shots /,/pricing` | Paths to screenshot as rendered | `/` |

`analyze.py CRAWL_DIR`

| Option | Meaning | Default |
|---|---|---|
| `--types "/blog/=post,/tag/=tag"` | Name page types by path prefix | first part of the path |
| `--content post` | The type holding your real content, for "links from content pages" | the type with the most pages |
| `--gsc coverage.json` | `{url: "Search Console coverage text"}`, to compare the crawl with what Google decided | none |

## Where this follows Google, and where it doesn't

Following [Google's documentation](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics): only `<a href>` links; raw HTML, then the rendered page; the smartphone user agent; the first 2 MB of each URL; JS, CSS and XHR but not images, video or fonts; robots.txt applied to those requests too; nothing kept between pages; permissions declined.

**Assumed, because Google doesn't publish it:** no clicks or scrolling, a 412x732 viewport and then a tall one, and waiting for the network to go quiet for up to 15 seconds.

**Different on purpose, to protect your data:** analytics requests and every POST, PUT, PATCH and DELETE are blocked, on any host, and reported.

These can still leave a mark, so check them for your site:

- A GET that changes something still runs. Exclude it with `--skip`.
- Analytics served from your own domain isn't blocked by host. Add a `--skip` pattern for its script.
- Page views still reach your server logs. Filter this crawler out of your stats.
- A firewall may block a fake Googlebot, since real ones can be verified by IP. If you see 403s, allow your own address.

## What it can't tell you

It's an imitation, and it isn't affiliated with Google. It can't show Google's rendering queue, its crawl budget, or how much Google trusts your site. A clean report means no obstacle was found, not that you will be indexed.

So check each cause against [Search Console](https://search.google.com/search-console) before you believe it. On worklore, 2-story keyword pages were indexed while a 27-story page was never crawled, which ruled out the theory that seemed most likely.

## Built with

[Crawlee](https://github.com/apify/crawlee), [Playwright](https://github.com/microsoft/playwright), [robots-parser](https://github.com/samclarke/robots-parser) and [cheerio](https://github.com/cheeriojs/cheerio).

Part of the [worklore](https://worklore.dev) project. MIT licensed.
