Ejecuta el flujo completo de deploy para Neto:

1. **Pre-flight checks**:
   - `npm test` — todos los tests deben pasar (el conteo no se escribe: envejece en cada sesión)
   - `npm --prefix webapp run test` — la suite de la webapp corre aparte, y el gate de Vercel
     la mira: si queda roja, el backend TAMPOCO sale (Railway espera el check suite entero)
   - Verificar que no hay `console.log` en archivos de produccion
   - `git status` — confirmar que no hay cambios sin commitear

2. **Commit y push**:
   - Crear commit con mensaje descriptivo
   - Push directo, incluidos los cambios que tocan `.github/workflows/**` (ver "Convenciones
     criticas" en `CLAUDE.md`). Lo que NO es automatico es la verificacion: eso es el paso 3

3. **Verificar deploys** — y ninguna de las tres se verifica pidiendole a la URL que cargue.
   **`api.neto.pe/health` responde `ok:true` en el backend VIEJO igual**, asi que no distingue
   "desplegado" de "Railway lo salteo por `watchPatterns`", "el gate lo dejo en `WAITING`" o
   "el build fallo". Lo mismo con `app.neto.pe` cargando. Los harness existen justamente
   porque esa comprobacion no separa nada:

   | Que preguntar | Con que |
   |---|---|
   | ¿quedo backend en `main` sin desplegar? | `node qa-e2e/backend-deploy-fresh.mjs` |
   | ¿lo que corre paso los tests? | `node qa-e2e/backend-deploy-tested.mjs` |
   | ¿el deploy **espero** al gate? | `node qa-e2e/backend-deploy-gated.mjs` |
   | Landing (Cloudflare Pages) | ultimo deploy via API |
   | Webapp (Vercel) | que el job `deploy-webapp` del run de `ci.yml` haya salido verde |

   Si un harness sale **exit 2**, no es PASS: es "no se pudo determinar". Tratarlo como verde
   es el fallo que vienen a atrapar.

   Y un `SKIPPED` de Railway **no es un fallo por si mismo**: `meta.skippedReason` dice cual de
   los dos es. `"No changes to watched files"` es `watchPatterns` y suele ser correcto (un
   commit de docs, un revert); `"CI check suite failed"` es el gate frenando algo roto. La
   seccion de `railway.json` en `CLAUDE.md` tiene el curl.

4. **Reportar** estado final de los 3 servicios, diciendo QUE lo demostro en cada uno.
