---
name: deploy-landing
description: Verifica y despliega la landing page de Neto a Cloudflare Pages, confirma que el deploy fue exitoso
allowed_tools: Bash, Read, Glob, Grep, WebFetch
---

# Deploy Landing — neto.pe (Cloudflare Pages)

Cuando el usuario quiera desplegar la landing page o verificar su estado en produccion.

> IMPORTANTE: la landing vive en un **repo separado**, `neto-landing`, en
> `C:\Vortik.dev\products\neto\landing` (NO en este repo FinBot). Antes vivia en
> `app/landing/`, que se elimino el 2026-06-23 por estar muerta. Trabajar siempre
> sobre `products/neto/landing/`.

## Flujo

### 1. Pre-checks
- Verificar que no hay errores de build: `cd C:\Vortik.dev\products\neto\landing && npm run build`
- Verificar que `products/neto/landing/out/` se genera correctamente (static export)
- Confirmar que no hay archivos grandes innecesarios (>1MB)
- **Correr el guard del hero contra el build local, ANTES de pushear.** Es mas
  barato descubrir aca que el guion diverge del backend que despues del deploy:

```bash
cd C:/Vortik.dev/products/neto/landing && npx serve out -l 4321 -s &
node scripts/verify-hero.mjs http://localhost:4321/
```

  Si falla `burbuja N literal`, el backend cambio una plantilla y la landing
  quedo mintiendo: hay que actualizar `MESSAGES` en `ChatSimulator.tsx` contra
  el archivo del backend que cita el comentario, NO relajar el guard.

### 2. Deploy
El deploy es automatico via Cloudflare Pages al hacer push a `main` del repo
`neto-landing` (github.com/FavioML/neto-landing).
- Proyecto Cloudflare: `neto-landing`
- Account ID: se obtiene de `CF_ACCOUNT_ID` (settings.local.json)
- Push: `cd C:\Vortik.dev\products\neto\landing && git push`

### 3. Verificacion post-deploy — el probe de frescura

**No alcanza con `curl -I https://neto.pe`**: si Cloudflare skipea el deploy o el
build falla, neto.pe devuelve 200 igual, sirviendo el build ANTERIOR. El 200 no
dice nada sobre que build esta detras.

Esperar ~3 min (tiempo de build) y correr:

```bash
cd C:/Vortik.dev/products/neto/landing && node scripts/probe-deploy-fresh.mjs
```

- **exit 0** = el commit que hoy es `main` tiene deployment de produccion exitoso.
- **exit 1** = STALE. El JSON separa los dos casos: sin deployment (el skip
  documentado de Cloudflare → re-disparar desde el dashboard o `git commit
  --allow-empty` + push) o `failure`/`canceled` (el build reviento → mirar logs
  en el dashboard).
- **exit 2** = indeterminado: faltan credenciales (`~/.config/neto/cloudflare.env`),
  la API rechazo la consulta, o el `main` local quedo atras del remoto.

Credenciales: `CF_ACCOUNT_ID` / `CF_PAGES_TOKEN` por entorno, o en
`~/.config/neto/cloudflare.env`. El proyecto de Pages es **`neto-landing`**.

### 4. Validacion — el guard del hero contra produccion

Ahora que el deploy salio, verificar que lo que sirve el CDN sigue siendo cierto:

```bash
cd C:/Vortik.dev/products/neto/landing && node scripts/verify-hero.mjs "https://neto.pe/?v=$(date +%s)"
```

Fija las tres burbujas del hero caracter por caracter contra las plantillas del
backend, chequea que el total del MiniDashboard coincida con el que el chat
reporta, y cubre 5 viewports (overflow horizontal, hidratacion del H1, errores
de consola). El cache-bust en la URL no es opcional: sin el, Cloudflare puede
servir el HTML viejo y el guard valida el deploy anterior.

Ademas (a ojo, no automatizado):
- Meta tags SEO (title, description, og:image)
- JSON-LD schema (Organization, FAQPage)

> Los dos pasos de arriba son los `harnesses` del canary diario
> (`landing/.claude/deploy-config.json`), asi que corren igual cada dia a las
> 10am aunque nadie despliegue. Este skill los corre en el momento del deploy,
> que es cuando el fallo se puede atribuir a un cambio concreto.

## Troubleshooting
- Cloudflare a veces skipea deploys — el paso 3 es exactamente el que lo detecta.
  Proyecto correcto: `neto-landing` (`neto-site` NO existe; era el nombre viejo
  y sigue vivo en `~/.claude/hooks/post-git-push-reminders.mjs`, hallazgo Q7).
- Si el build falla, revisar `products/neto/landing/next.config.ts` y dependencias
