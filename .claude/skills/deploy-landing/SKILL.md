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

### 2. Deploy
El deploy es automatico via Cloudflare Pages al hacer push a `main` del repo
`neto-landing` (github.com/FavioML/neto-landing).
- Proyecto Cloudflare: `neto-landing`
- Account ID: se obtiene de `CF_ACCOUNT_ID` (settings.local.json)
- Push: `cd C:\Vortik.dev\products\neto\landing && git push`

### 3. Verificacion post-deploy
Verificar estado del deploy via API de Cloudflare:
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/$CF_PAGES_PROJECT/deployments" \
  -H "Authorization: Bearer $CF_PAGES_TOKEN" | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const latest = d.result[0];
console.log('Estado:', latest.latest_stage.status);
console.log('URL:', latest.url);
console.log('Fecha:', latest.created_on);
"
```

### 4. Validacion
- Verificar que https://neto.pe carga correctamente
- Confirmar meta tags SEO (title, description, og:image)
- Verificar JSON-LD schema (Organization, FAQPage)

## Troubleshooting
- Cloudflare a veces skipea deploys — verificar con la API si el ultimo deploy corresponde al ultimo commit (`CF_PAGES_PROJECT=neto-landing`)
- Si el build falla, revisar `products/neto/landing/next.config.ts` y dependencias
