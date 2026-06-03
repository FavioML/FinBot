---
name: supabase-check
description: Verifica el estado de Supabase (tablas, RLS, datos) para el proyecto Neto
allowed_tools: Bash, Read, Grep, mcp__942ad7b0-9c7b-4b2a-966a-834470e2654f__execute_sql, mcp__942ad7b0-9c7b-4b2a-966a-834470e2654f__list_tables, mcp__942ad7b0-9c7b-4b2a-966a-834470e2654f__get_project
---

# Supabase Check — Neto

Verifica el estado de la base de datos Supabase del proyecto Neto.

## Proyecto
- ID: zvorjqlubmfrjtkbhqcx
- Region: (verificar con get_project)

## Checks a realizar

### 1. Estado del proyecto
Verificar que el proyecto esta activo y respondiendo.

### 2. Tablas (11 esperadas)
Usar `list_tables` para verificar que existen:
- `usuarios` — usuarios registrados
- `transacciones` — movimientos financieros
- `presupuestos` — limites por categoria
- `categorias_personalizadas` — categorias del usuario
- `cuentas_gmail` — cuentas conectadas
- `comercios_aprendidos` — reglas de clasificacion
- `referidos` — sistema de referidos
- `metas_ahorro` — metas de ahorro
- `suscripciones` — suscripciones detectadas
- `emails_procesados` — dedup de correos
- `errores_monitoreo` — log de errores

### 3. RLS (Row Level Security)
Verificar que TODAS las tablas tienen RLS activo:
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```
Todas deben tener `rowsecurity = true`.

### 4. Estadisticas rapidas
```sql
SELECT
  (SELECT count(*) FROM usuarios) as usuarios,
  (SELECT count(*) FROM transacciones) as transacciones,
  (SELECT count(*) FROM presupuestos) as presupuestos,
  (SELECT count(*) FROM metas_ahorro) as metas;
```

### 5. Reporte
Presentar un resumen claro:
- Estado del proyecto (activo/inactivo)
- Tablas encontradas vs esperadas
- RLS status por tabla
- Conteos de registros clave
- Alertas si algo falta o esta mal
