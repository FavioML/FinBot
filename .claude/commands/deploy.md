Ejecuta el flujo completo de deploy para Neto:

1. **Pre-flight checks**:
   - `npm test` — todos los tests deben pasar (el conteo no se escribe: envejece en cada sesión)
   - Verificar que no hay `console.log` en archivos de produccion
   - `git status` — confirmar que no hay cambios sin commitear

2. **Commit** (si hay cambios staged):
   - Crear commit con mensaje descriptivo
   - NO hacer push automaticamente — confirmar con el usuario primero

3. **Verificar deploys**:
   - Backend (Railway): verificar que `api.neto.pe/health` responde OK
   - Landing (Cloudflare Pages): verificar ultimo deploy via API
   - Webapp (Vercel): verificar que `app.neto.pe` carga correctamente

4. **Reportar** estado final de los 3 servicios
