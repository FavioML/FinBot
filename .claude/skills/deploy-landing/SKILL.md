---
name: deploy-landing
description: Verifica y despliega la landing page de Neto a Cloudflare Pages, confirma que el deploy fue exitoso
allowed_tools: Bash, Read, Glob, Grep, WebFetch
---

# Deploy Landing — neto.pe (Cloudflare Pages)

Cuando el usuario quiera desplegar la landing page o verificar su estado en produccion.

## Flujo

### 1. Pre-checks
- Verificar que no hay errores de build: `cd landing && npm run build`
- Verificar que `landing/out/` se genera correctamente
- Confirmar que no hay archivos grandes innecesarios (>1MB)

### 2. Deploy
El deploy es automatico via Cloudflare Pages al hacer push a main.
- Proyecto: `neto-site`
- Root directory: `landing/`
- Build watch paths: `landing/**`
- Account ID: se obtiene de la variable CF_ACCOUNT_ID en settings.local.json

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
- Cloudflare a veces skipea deploys — verificar con la API si el ultimo deploy corresponde al ultimo commit
- Si el build falla, revisar `landing/next.config.ts` y dependencias
