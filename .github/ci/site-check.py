#!/usr/bin/env python3
"""Static checks for the website (there is no build step, so this is the "build").

- every page: <title> and <meta charset>; JSON-LD blocks parse; no duplicate ids
- links / assets: same-site href/src (relative, "/...", or https://www.hiogolf.cn/... / https://hiogolf.cn/...,
  including og:image / canonical / alternate) point at a file in the repo or a landing route that nginx
  serves; "#frag" and "page.html#frag" point at an existing id
- landing pages (the try_files targets in nginx/hiogolf-site.conf) are noindex and not in the sitemap
- .well-known/apple-app-site-association is valid JSON and every path in it has an nginx landing route
- sitemap.xml parses and every URL in it exists; robots.txt points at the sitemap

Run from anywhere: python3 .github/ci/site-check.py
"""
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urlsplit

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SITE_HOSTS = {"www.hiogolf.cn", "hiogolf.cn"}
SKIP_DIRS = {".git", ".github", ".claude", "scripts", "nginx", "docs", "node_modules"}
SKIP_SCHEMES = ("mailto:", "tel:", "sms:", "javascript:", "data:", "hiogolf:", "weixin:")
# search-console verification files: not real pages
VERIFICATION_PAGE = re.compile(r"^google[0-9a-f]+\.html$")

errors = []


def err(where, msg):
    errors.append(f"{where}: {msg}")


def rel(path):
    return os.path.relpath(path, ROOT)


nginx_conf = open(os.path.join(ROOT, "nginx", "hiogolf-site.conf"), encoding="utf-8").read()
# landing routes: `location ~ ^/m/\d+/?$ { try_files /meetup.html =404; }`
ROUTES = [(re.compile(m.group(1)), m.group(2)) for m in re.finditer(
    r"location ~ (\^/[^\s{]+)\s*\{\s*try_files /([\w.-]+\.html) =404;", nginx_conf)]
if not ROUTES:
    err("nginx/hiogolf-site.conf", "found no landing-page routes (did the location syntax change? update site-check.py)")
LANDING_PAGES = {page for _, page in ROUTES}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.dup_ids, self.refs = set(), set(), []
        self.title = self.charset = self.noindex = False
        self.ld, self._in_ld, self._buf = [], False, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ("id", "name") if tag == "a" else ("id",):
            if a.get(key):
                if key == "id" and a[key] in self.ids:
                    self.dup_ids.add(a[key])
                self.ids.add(a[key])
        line = self.getpos()[0]
        for key in ("href", "src"):
            if a.get(key) is not None:
                self.refs.append((line, tag, a[key]))
        if tag == "meta":
            if "charset" in a or a.get("http-equiv", "").lower() == "content-type":
                self.charset = True
            if a.get("name") == "robots" and "noindex" in (a.get("content") or ""):
                self.noindex = True
            if (a.get("property") or a.get("name") or "") in ("og:image", "og:url", "twitter:image"):
                self.refs.append((line, "meta", a.get("content") or ""))
        if tag == "title":
            self.title = True
        if tag == "script" and a.get("type") == "application/ld+json":
            self._in_ld, self._buf = True, []

    def handle_data(self, data):
        if self._in_ld:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._in_ld:
            self.ld.append("".join(self._buf))
            self._in_ld = False


def route_page(path):
    for pattern, page in ROUTES:
        if pattern.match(path):
            return page
    return None


def resolve(path):
    """URL path on www.hiogolf.cn -> repo file it serves (or None)."""
    page = route_page(path)
    if page:
        return os.path.join(ROOT, page)
    f = os.path.join(ROOT, path.lstrip("/"))
    if path.endswith("/"):
        f = os.path.join(f, "index.html")
    return f if os.path.isfile(f) else None


pages = {}
for d, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
    for name in files:
        if name.endswith(".html"):
            path = os.path.join(d, name)
            p = Page()
            p.feed(open(path, encoding="utf-8").read())
            pages[path] = p
if not pages:
    err(ROOT, "no .html pages found")

for path, p in sorted(pages.items()):
    where = rel(path)
    if VERIFICATION_PAGE.match(os.path.basename(path)):
        continue
    if not p.title:
        err(where, "no <title>")
    if not p.charset:
        err(where, "no <meta charset>")
    for dup in sorted(p.dup_ids):
        err(where, f'duplicate id="{dup}"')
    for block in p.ld:
        try:
            json.loads(block)
        except ValueError as e:
            err(where, f"JSON-LD does not parse: {e}")
    name = os.path.relpath(path, ROOT)
    if name in LANDING_PAGES and not p.noindex:
        err(where, 'landing page without <meta name="robots" content="noindex">')

    for line, tag, ref in p.refs:
        ref = ref.strip()
        here = f"{where}:{line} <{tag}> {ref!r}"
        if not ref or ref.startswith(SKIP_SCHEMES) or ref.startswith("//"):
            continue
        u = urlsplit(ref)
        if u.scheme in ("http", "https"):
            if u.hostname not in SITE_HOSTS:
                continue   # external
            if u.scheme != "https":
                err(here, "own site linked over http")
            url_path = u.path or "/"
        elif u.scheme:
            continue
        elif not u.path:   # "#frag" on this page
            if u.fragment and u.fragment not in p.ids:
                err(here, "no element with this id on the page")
            continue
        elif u.path.startswith("/"):
            url_path = u.path
        else:
            url_path = "/" + os.path.relpath(os.path.normpath(os.path.join(os.path.dirname(path), u.path)), ROOT)
        target = resolve(url_path)
        if not target:
            err(here, "points at nothing (no such file in the repo, and not a landing route)")
            continue
        if u.fragment and target.endswith(".html"):
            tp = pages.get(target)
            if tp and u.fragment not in tp.ids:
                err(here, f"no id={u.fragment!r} in {rel(target)}")

# AASA: valid JSON; each path pattern has an nginx landing route
aasa_path = os.path.join(ROOT, ".well-known", "apple-app-site-association")
try:
    aasa = json.load(open(aasa_path, encoding="utf-8"))
    paths = [pp for det in aasa["applinks"]["details"] for pp in det.get("paths", [])]
    if not paths:
        err(rel(aasa_path), "no applinks paths")
    for pp in paths:
        prefix = pp.rstrip("*")
        if not any(pat.pattern.startswith("^" + prefix) for pat, _ in ROUTES):
            err(rel(aasa_path), f"path {pp!r} has no landing route in nginx/hiogolf-site.conf")
except (ValueError, KeyError, TypeError) as e:
    err(rel(aasa_path), f"not valid AASA JSON: {e}")

# sitemap.xml / robots.txt
ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9", "x": "http://www.w3.org/1999/xhtml"}
try:
    sm = ET.parse(os.path.join(ROOT, "sitemap.xml")).getroot()
    urls = [e.text.strip() for e in sm.findall("s:url/s:loc", ns)] + \
           [e.get("href") for e in sm.findall("s:url/x:link", ns)]
    if not urls:
        err("sitemap.xml", "no URLs")
    for url in urls:
        u = urlsplit(url)
        if u.scheme != "https" or u.hostname != "www.hiogolf.cn":
            err("sitemap.xml", f"{url}: not on https://www.hiogolf.cn/")
            continue
        target = resolve(u.path or "/")
        if not target:
            err("sitemap.xml", f"{url}: no such page")
        elif os.path.relpath(target, ROOT) in LANDING_PAGES:
            err("sitemap.xml", f"{url}: landing pages are noindex, keep them out of the sitemap")
except ET.ParseError as e:
    err("sitemap.xml", f"does not parse: {e}")
robots = open(os.path.join(ROOT, "robots.txt"), encoding="utf-8").read()
if "Sitemap: https://www.hiogolf.cn/sitemap.xml" not in robots:
    err("robots.txt", "no 'Sitemap: https://www.hiogolf.cn/sitemap.xml' line")

n_refs = sum(len(p.refs) for p in pages.values())
if errors:
    print(f"site-check: {len(errors)} problem(s) in {len(pages)} pages / {n_refs} links:")
    for e in errors:
        print("  " + e)
    sys.exit(1)
print(f"site-check: ok ({len(pages)} pages, {n_refs} links/assets, {len(ROUTES)} landing routes)")
