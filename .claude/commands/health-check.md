Revisa el estado de salud de todos los servicios de Neto en produccion:

1. **Backend (api.neto.pe)**:
   - GET `https://api.neto.pe/health` — debe retornar 200 OK
   - Reportar uptime y version si disponible

2. **Landing (neto.pe)**:
   - Verificar ultimo deploy en Cloudflare Pages via API
   - Confirmar que el deploy corresponde al ultimo commit

3. **Webapp (app.neto.pe)**:
   - Verificar que la pagina carga (no 500/502)
   - Confirmar que el login OAuth esta funcional

4. **Supabase**:
   - Verificar proyecto activo
   - Contar usuarios y transacciones recientes (ultimas 24h)

5. **Resumen**:
   - Tabla con estado de cada servicio (OK / WARNING / DOWN)
   - Alertas si algo requiere atencion
