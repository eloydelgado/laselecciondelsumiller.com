"""Crea una copia estatica de https://www.laselecciondelsumiller.com en ./site

Uso:  python tools/mirror.py [directorio_salida]          (rastrear + postproceso)
      python tools/mirror.py [directorio_salida] --post   (solo postproceso)

- Rastrea todas las paginas HTML internas (siguiendo enlaces + sitemap).
- Descarga todos los recursos del dominio (CSS, JS, imagenes, fuentes, video).
- Reescribe las URLs absolutas del dominio a rutas relativas a la raiz (/...).
"""
import html
import re
import sys
import time
from collections import deque
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote

import requests
from bs4 import BeautifulSoup

BASE = "https://www.laselecciondelsumiller.com"
HOSTS = {"www.laselecciondelsumiller.com", "laselecciondelsumiller.com"}
_args = [a for a in sys.argv[1:] if not a.startswith("--")]
OUT = Path(_args[0] if _args else "site").resolve()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) static-mirror"

SKIP = re.compile(
    r"^/(wp-admin|wp-login|wp-json|xmlrpc\.php|wp-cron\.php|cgi-bin)"
    r"|/feed/?$|/embed/?$|/trackback/?$"
    r"|^/(?!\d{4}/|page/)[^/]+/\d+/?$"  # /slug/123/ = paginacion interna falsa de WP
)
ABS_RE = re.compile(
    r"(?:https?:)?(?:\\?/){2}(?:www\.)?laselecciondelsumiller\.com((?:\\?/)[^\s\"'<>()\\]*(?:\\/[^\s\"'<>()\\]*)*)?"
)
# Paginas que WordPress enlaza por ID (/?page_id=N, /?p=N), que en estatico no
# existen: el aviso de cookies enlaza la politica de privacidad como /?page_id=3.
QUERY_PAGES = {"page_id=3": "/politica-privacidad/", "p=3": "/politica-privacidad/"}
QUERY_PAGE_RE = re.compile(
    r"((?:https?:)?(?:\\?/){2}(?:www\.)?laselecciondelsumiller\.com)?(?:\\?/)\?((?:page_id|p)=\d+)(?=[\"'#&\s])"
)
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+?)['\"]?\s*\)|@import\s+['\"]([^'\"]+)['\"]")

session = requests.Session()
session.headers["User-Agent"] = UA

pages_q, assets_q = deque(), deque()
seen = set()
saved = {}  # url -> local path
errors = []


def norm(url, base=BASE + "/"):
    """Devuelve URL absoluta normalizada si es del dominio, si no None."""
    if not url:
        return None
    url = html.unescape(url.strip()).replace("\\/", "/")
    if url.startswith(("data:", "mailto:", "tel:", "javascript:", "#")):
        return None
    url = urljoin(base, url)
    p = urlsplit(url)
    if p.hostname not in HOSTS or p.scheme not in ("http", "https"):
        return None
    path = p.path or "/"
    if path == "/" and p.query in QUERY_PAGES:
        return BASE + QUERY_PAGES[p.query]
    if SKIP.search(path):
        return None
    if p.query and not re.search(r"\.\w{2,5}$", path) and not re.search(r"/page/\d+/?$", path):
        return None  # URLs dinamicas (?s=, ?replytocom=, ?p=) no se reflejan
    return f"{BASE}{path}"  # query descartada en assets


def is_asset(url):
    last = urlsplit(url).path.rsplit("/", 1)[-1]
    return "." in last and not last.endswith((".php", ".html", ".htm"))


def enqueue(url):
    if url and url not in seen:
        seen.add(url)
        (assets_q if is_asset(url) else pages_q).append(url)


def local_path(url, is_html):
    path = unquote(urlsplit(url).path)
    if is_html:
        if not path.endswith("/") and not path.endswith((".html", ".htm")):
            path += "/"
        if path.endswith("/"):
            path += "index.html"
    return OUT / path.lstrip("/")


def fetch(url):
    for attempt in range(3):
        try:
            r = session.get(url, timeout=60)
            time.sleep(0.15)
            return r
        except requests.RequestException as e:
            if attempt == 2:
                errors.append(f"{url}: {e}")
            time.sleep(2)
    return None


def scan_text_for_abs(text):
    for m in ABS_RE.finditer(text):
        enqueue(norm(m.group(0)))


def scan_css(text, css_url):
    for m in CSS_URL_RE.finditer(text):
        enqueue(norm(m.group(1) or m.group(2), css_url))


def handle_page(url):
    r = fetch(url)
    if r is None:
        return
    final = norm(r.url) or url
    if r.status_code != 200:
        errors.append(f"{url}: HTTP {r.status_code}")
        return
    if "text/html" not in r.headers.get("Content-Type", ""):
        save_bytes(url, r.content, False)
        return
    if final != url:  # redireccion interna -> asegurar destino
        enqueue(final)
    text = r.text
    soup = BeautifulSoup(text, "html.parser")
    for tag in soup.find_all(True):
        for attr, val in tag.attrs.items():
            if isinstance(val, list):
                val = " ".join(val)
            if attr in ("href", "src", "poster", "action"):
                enqueue(norm(val, url))
            elif (attr == "content" or attr.startswith("data-")) and val.strip().startswith(("http", "//", "/")):
                enqueue(norm(val, url))
            elif attr in ("srcset", "data-srcset", "imagesrcset"):
                for part in val.split(","):
                    enqueue(norm(part.strip().split(" ")[0], url))
            elif attr == "style":
                scan_css(val, url)
    for st in soup.find_all("style"):
        scan_css(st.get_text(), url)
    scan_text_for_abs(text)
    # Enlaces de modulos/columnas de Divi (et_link_options_data): JSON con rutas
    # relativas escapadas, p. ej. "url":"\/politica-de-privacidad\/"
    for m in re.finditer(r'"url":"([^"]+)"', text):
        enqueue(norm(m.group(1), url))
    save_bytes(url, r.content, True)
    print(f"[page]  {url}")


def handle_asset(url):
    r = fetch(url)
    if r is None:
        return
    if r.status_code != 200:
        errors.append(f"{url}: HTTP {r.status_code}")
        return
    if "text/html" in r.headers.get("Content-Type", "") and not url.endswith((".html", ".htm")):
        # p.ej. /algo.php-like o rutas con punto que son paginas
        pages_q.append(url)
        return
    if url.endswith(".css"):
        scan_css(r.text, url)
        scan_text_for_abs(r.text)
    elif url.endswith((".js", ".json", ".svg")):
        scan_text_for_abs(r.text)
    save_bytes(url, r.content, False)


def save_bytes(url, data, is_html):
    p = local_path(url, is_html)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    saved[url] = p


# ---- Reescritura de URLs ---------------------------------------------------
REWRITES = [
    (re.compile(r"https?:\\/\\/(?:www\.)?laselecciondelsumiller\.com(?=\\/|[\"'])"), ""),
    (re.compile(r"(?:https?:)?//(?:www\.)?laselecciondelsumiller\.com(?=/|[\"'\s<)?#])"), ""),
]
STRIP_HEAD = [
    re.compile(r"<link[^>]+rel=['\"](?:EditURI|wlwmanifest|pingback|shortlink|https://api\.w\.org/)['\"][^>]*>\s*", re.I),
    re.compile(r"<link[^>]+type=['\"]application/(?:rss|atom)\+xml['\"][^>]*>\s*", re.I),
    re.compile(r"<link[^>]+type=['\"](?:application/json\+oembed|text/xml\+oembed)['\"][^>]*>\s*", re.I),
    re.compile(r"<link[^>]+rel=['\"]alternate['\"][^>]+/wp-json/[^>]*>\s*", re.I),
]


# Zonas que deben seguir con URL absoluta (SEO): canonical, Open Graph/Twitter y JSON-LD
PROTECT = re.compile(
    r"<link[^>]+rel=['\"]canonical['\"][^>]*>"
    r"|<meta[^>]+(?:property|name)=['\"](?:og:|twitter:)[^>]*>"
    r"|<script[^>]+application/ld\+json[^>]*>.*?</script>",
    re.S | re.I,
)


def rewrite(text, is_html):
    if is_html:
        for rx in STRIP_HEAD:
            text = rx.sub("", text)
        out, pos = [], 0
        for m in PROTECT.finditer(text):
            out.append(rewrite_urls(text[pos:m.start()], True))
            out.append(re.sub(r"https?://(?:www\.)?laselecciondelsumiller\.com", BASE, m.group(0)))
            pos = m.end()
        out.append(rewrite_urls(text[pos:], True))
        return "".join(out)
    return rewrite_urls(text, False)


def query_page(m):
    target = QUERY_PAGES.get(m.group(2))
    return (m.group(1) or "") + target if target else m.group(0)


def rewrite_urls(text, is_html):
    text = QUERY_PAGE_RE.sub(query_page, text)
    for rx, rep in REWRITES:
        text = rx.sub(rep, text)
    if is_html:
        # enlace a la raiz que quedo vacio: href="" -> href="/" (solo atributos
        # HTML reales, no concatenaciones JS tipo '<a href="'+url)
        text = re.sub(r'(\s(?:href|action)=)(["\'])\2(?=[\s>/])', r"\1\2/\2", text)
    return text


def write_hosting_files():
    """Ficheros para GitHub Pages: dominio, sin Jekyll, robots y sitemap."""
    (OUT / "CNAME").write_text("www.laselecciondelsumiller.com\n", encoding="utf-8")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    (OUT / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\n\nSitemap: {BASE}/sitemap.xml\n", encoding="utf-8"
    )
    urls = sorted(
        "/" + p.parent.relative_to(OUT).as_posix() + "/"
        for p in OUT.rglob("index.html")
    )
    urls = [u.replace("/./", "/") for u in urls]
    urls = [u for u in urls if not re.search(r"/page/\d+/|^/author/|^/\d{4}/", u)]
    body = "".join(f"  <url><loc>{BASE}{u}</loc></url>\n" for u in urls)
    (OUT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{body}</urlset>\n",
        encoding="utf-8",
    )


EXTRAS = Path(__file__).resolve().parent.parent / "extras"
FORM_TAG = '<script src="/assets/js/formularios.js" defer></script>'

# La 404 se sirve en cualquier ruta, asi que sus rutas relativas se resuelven
# con un <base> calculado: "/<repo>/" en *.github.io y "/" en el dominio propio.
BASE_TAG = (
    "<script>(function(){var s=location.pathname.split('/')[1];"
    "document.write('<base href=\"'+(/\\.github\\.io$/.test(location.hostname)&&s"
    "?'/'+s+'/':'/')+'\">')})()</script>"
)


def relativize():
    """Convierte las rutas absolutas a la raiz (/wp-content/..., \\/blog\\/...,
    url(/...)) en relativas a cada fichero, para que la web funcione tanto en la
    raiz de un dominio como en una subcarpeta (usuario.github.io/repo/)."""
    tops = "|".join(sorted((re.escape(p.name) for p in OUT.iterdir()), key=len, reverse=True))
    # Tambien tras &quot; / &#039;: Divi guarda una copia del contenido como JSON
    # escapado dentro de atributos (data-et-multi-view) y la inyecta por JS.
    after = r"(?:(?<=[\"'(=,\s])|(?<=&quot;)|(?<=&#039;))"
    plain = re.compile(after + r"/(?=(?:%s)(?:[/\"'?#)\s,&]|\\/|$))" % tops)
    escaped = re.compile(after + r"\\/(?=(?:%s)(?:\\/|[\"'?#&]))" % tops)
    home = re.compile(r"(\s(?:href|action)=)([\"'])/\2")
    n = 0
    for p in list(OUT.rglob("*.html")) + list(OUT.rglob("*.css")):
        is_404 = p == OUT / "404.html"
        depth = 0 if is_404 else len(p.relative_to(OUT).parts) - 1
        rel = "../" * depth
        t = p.read_text(encoding="utf-8")
        new = plain.sub(lambda m: rel, t)
        new = escaped.sub(lambda m: rel.replace("/", "\\/"), new)
        new = home.sub(lambda m: m.group(1) + m.group(2) + (rel or "./") + m.group(2), new)
        if is_404 and "<base href" not in new:
            new = re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + BASE_TAG, new, count=1)
        if new != t:
            p.write_text(new, encoding="utf-8", newline="")
            n += 1
    print(f"Postproceso: rutas relativas en {n} ficheros")


# ---- Cloudflare -------------------------------------------------------------
# La web original pasa por Cloudflare, que ofusca los correos y anade scripts
# propios (/cdn-cgi/...). Fuera de Cloudflare no existen: se decodifican los
# correos y se quitan los scripts.
CF_SCRIPTS = [
    re.compile(r"<script[^>]*cdn-cgi/scripts/[^>]*email-decode[^>]*>\s*</script>", re.I),
    re.compile(r"<script>\(function\(\)\{function c\(\).*?challenge-platform.*?</script>", re.S),
]
CF_LINK = re.compile(r"""href=(["'])[^"']*/cdn-cgi/l/email-protection#([0-9a-fA-F]+)\1""")
CF_SPAN = re.compile(
    r"""<(span|a)[^>]*class=["']__cf_email__["'][^>]*data-cfemail=["']([0-9a-fA-F]+)["'][^>]*>.*?</\1>""", re.S
)
CF_HREF_ONLY = re.compile(r"""href=(["'])[^"']*/cdn-cgi/l/email-protection\1""")


def cf_decode(hexstr):
    key = int(hexstr[:2], 16)
    return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))


def undo_cloudflare(t):
    for rx in CF_SCRIPTS:
        t = rx.sub("", t)
    t = CF_LINK.sub(lambda m: f"href={m.group(1)}mailto:{cf_decode(m.group(2))}{m.group(1)}", t)
    t = CF_SPAN.sub(lambda m: cf_decode(m.group(2)), t)
    return t


# Correos a sustituir en las paginas (esta web no muestra ninguno).
EMAIL_REPLACE = {}

FORM_RE = re.compile(r"<form[^>]+class=[\"'][^\"']*(?:wpcf7-form|et_pb_contact_form)|et_pb_newsletter_form", re.I)


def postprocess():
    """Anade lo propio de la version estatica: ficheros de extras/, el script
    de formularios (Firebase) en las paginas con formularios (Contact Form 7 o
    Divi), correos sin ofuscar de Cloudflare y rutas relativas."""
    import shutil

    if EXTRAS.is_dir():
        shutil.copytree(EXTRAS, OUT, dirs_exist_ok=True)
    shutil.rmtree(OUT / "cdn-cgi", ignore_errors=True)
    n = 0
    for p in OUT.rglob("*.html"):
        t = orig = p.read_text(encoding="utf-8")
        t = undo_cloudflare(t)
        for old, new in EMAIL_REPLACE.items():
            t = t.replace(old, new)
        if "cdn-cgi/l/email-protection" in t:
            print(f"  AVISO: correo de Cloudflare sin decodificar en {p.relative_to(OUT)}")
        if not FORM_RE.search(t):
            t = re.sub(r"<script src=\"[./]*assets/js/formularios\.js\" defer></script>\n?", "", t)
        elif "assets/js/formularios.js" not in t:
            t = t.replace("</body>", FORM_TAG + "\n</body>", 1)
            n += 1
        if t != orig:
            p.write_text(t, encoding="utf-8", newline="")
    relativize()
    write_hosting_files()
    print(f"Postproceso: script de formularios anadido a {n} paginas")


# Recursos que solo se referencian desde JS (no aparecen en el HTML).
EXTRA_ASSETS = []


def main():
    if "--post" in sys.argv:  # solo postproceso, sin rastrear
        postprocess()
        return
    OUT.mkdir(parents=True, exist_ok=True)
    enqueue(BASE + "/")
    for u in EXTRA_ASSETS:
        enqueue(BASE + u)
    for sm in ("page-sitemap.xml", "post-sitemap.xml", "category-sitemap.xml", "product-sitemap.xml"):
        r = fetch(f"{BASE}/{sm}")
        if r is not None and r.status_code == 200:
            for loc in re.findall(r"<loc>([^<]+)</loc>", r.text):
                enqueue(norm(loc))
    while pages_q or assets_q:
        if pages_q:
            handle_page(pages_q.popleft())
        else:
            handle_asset(assets_q.popleft())

    # 404 personalizada
    r = fetch(f"{BASE}/__pagina-inexistente-mirror__/")
    if r is not None and "text/html" in r.headers.get("Content-Type", ""):
        (OUT / "404.html").write_bytes(r.content)
        saved["404"] = OUT / "404.html"
        # Recursos que solo usa la 404 (CSS de Divi para "notfound", fitvids...)
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup.find_all(["link", "script", "img"]):
            enqueue(norm(tag.get("href") or tag.get("src")))
        scan_text_for_abs(r.text)
        while assets_q:
            handle_asset(assets_q.popleft())

    for url, p in saved.items():
        if p.suffix in (".html", ".htm", ".css", ".js", ".json", ".xml", ".svg", ".txt"):
            try:
                t = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            p.write_text(rewrite(t, p.suffix in (".html", ".htm")), encoding="utf-8", newline="")

    postprocess()
    pages = sum(1 for p in saved.values() if p.suffix == ".html")
    print(f"\nPaginas: {pages}  Recursos: {len(saved) - pages}  Errores: {len(errors)}")
    for e in errors:
        print("  ERR", e)


if __name__ == "__main__":
    main()
