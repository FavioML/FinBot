---
paths:
  - "migrations/**/*.sql"
  - "supabase/**/*.sql"
  - "**/schema.sql"
---

# Reglas Database (Neto Supabase)

- Migraciones append-only. Nueva migracion = nuevo archivo con timestamp prefix.
- **Aplicarla deja DOS rastros, y el segundo se olvida.** El archivo en `migrations/` y la fila en
  `supabase_migrations.schema_migrations`. Si la aplicas por SQL suelto (MCP `execute_sql`, editor
  de Supabase), el ledger NO se entera. Paso con la 068 y la 069, y el costo no es cosmetico: la
  query de diagnostico que este repo usa para saber si algo corrio
  (`select ... from supabase_migrations.schema_migrations where statements::text ilike '%X%'`)
  contesta que NO sobre constraints que SI estaban vivas. Usa `apply_migration`, o inserta la fila
  a mano con el basename EXACTO del archivo (`068_deudas_montos_check`) como `name`.
- El ledger remoto **no** es la lista completa de lo que corre: 36 migraciones aplicadas no tienen
  archivo local (28 anteriores a la 001 + 8 de consola), asi que `migrations/` nunca pudo
  reconstruir la base y no es esa su funcion. Ante "escribi X y leo Y", consulta el esquema VIVO
  (`pg_trigger`, `pg_proc`, `pg_constraint`, `information_schema`), no el arbol.
- Toda tabla con datos de usuario requiere RLS habilitado. NO push de tablas sin RLS a prod.
- Politicas RLS: nombrar `<tabla>_<accion>_<rol>` para que sean grepeables.
- FK con `on delete cascade` solo cuando la dependencia es total. Sino, `set null`.
- Indices: agregar para columnas que aparezcan en `WHERE`/`ORDER BY` frecuentes. Documentar en comentario.
- Antes de aplicar migracion en prod: probar en branch de Supabase, verificar tiempo de lock en tabla con datos.
