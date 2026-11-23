# laselecciondelsumiller.com

Copia estática de la web de La Selección del Sumiller (antes en WordPress + Divi), publicada con GitHub Pages en https://www.laselecciondelsumiller.com.

## Estructura

- `site/`: la web publicada (HTML, CSS, JS e imágenes). Incluye `CNAME`, `robots.txt`, `sitemap.xml` y `404.html`.
- `tools/mirror.py`: regenera `site/` rastreando la WordPress original.
- `tools/serve.py`: servidor local para previsualizar (admite Range, necesario para los vídeos MP4).
- `.github/workflows/pages.yml`: publica `site/` en GitHub Pages en cada push a `main`.

La web tiene dos páginas: la portada (con el formulario de contacto) y la política de privacidad.
El menú «Catálogo» enlaza a un sitio externo de Canva.

## Uso

```sh
python tools/serve.py 8000          # previsualizar en http://127.0.0.1:8000/
python tools/mirror.py site         # regenerar desde la WordPress (si sigue en línea)
python tools/mirror.py site --post  # solo el postproceso (extras, formularios, rutas)
```

Las rutas son relativas a cada página (`../wp-content/...`; el postproceso de `mirror.py` las convierte),
así que la web funciona tanto en la raíz del dominio como en https://eloydelgado.github.io/laselecciondelsumiller.com/.
La `404.html` calcula su `<base>` según dónde se sirva.

## DNS para GitHub Pages

El dominio principal es `www.laselecciondelsumiller.com`, como en la WordPress (que redirige el apex a `www`).

- `www` → registro CNAME a `eloydelgado.github.io`
- `laselecciondelsumiller.com` (apex) → registros A: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
  (GitHub redirige el apex a `www`)

Ahora el dominio pasa por Cloudflare. Si se mantiene, los registros deben ir en modo «solo DNS» (nube gris)
al menos hasta que GitHub emita el certificado HTTPS.

## Cloudflare

La WordPress pasaba por Cloudflare, que añade sus scripts (`/cdn-cgi/...`) y ofusca los correos. Fuera de
Cloudflare eso no existe, así que el postproceso de `mirror.py` quita esos scripts (y decodificaría los correos,
aunque esta web no muestra ninguno).

## Enlace a la política de privacidad

El aviso de cookies (plugin GDPR Cookie Compliance) enlaza la política como `/?page_id=3`, que en WordPress
redirige a `/politica-privacidad/` y en estático no existe. `mirror.py` rastrea esa página y reescribe el enlace
(`QUERY_PAGES`).

## Formularios

Los formularios se envían con [extras/assets/js/formularios.js](extras/assets/js/formularios.js): valida en el
navegador y llama a la Cloud Function `contactoWeb` del proyecto Firebase `grupodelgado-prod` (la misma que usan
delgadoseleccion.com, cepasconhistoria.com, conservaslabrujula.com y conservasramonpena.com), protegida con
App Check + reCAPTCHA Enterprise.

- **Contacto** (portada): formulario de contacto de Divi (nombre y correo obligatorios, mensaje opcional) con el
  captcha de suma de Divi, que en WordPress comprobaba el servidor y aquí comprueba `formularios.js`.
  Es el único formulario de la web.
- Los ficheros de `extras/` se copian a `site/`, y el `<script>` se añade a las páginas con formulario
  mediante `python tools/mirror.py site --post` (también se hace al regenerar).
- La clave de reCAPTCHA Enterprise debe tener `www.laselecciondelsumiller.com` en su lista de dominios permitidos.
- Si se deja vacía `recaptchaSiteKey`, el formulario abre el correo del visitante dirigido a web@grupo-delgado.com.

## Limitaciones

- El buscador de Divi (`?s=`) necesita PHP y no funciona en estático.
