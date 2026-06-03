---
paths:
  - "migrations/**/*.sql"
  - "supabase/**/*.sql"
  - "**/schema.sql"
---

# Reglas Database (Neto Supabase)

- Migraciones append-only. Nueva migracion = nuevo archivo con timestamp prefix.
- Toda tabla con datos de usuario requiere RLS habilitado. NO push de tablas sin RLS a prod.
- Politicas RLS: nombrar `<tabla>_<accion>_<rol>` para que sean grepeables.
- FK con `on delete cascade` solo cuando la dependencia es total. Sino, `set null`.
- Indices: agregar para columnas que aparezcan en `WHERE`/`ORDER BY` frecuentes. Documentar en comentario.
- Antes de aplicar migracion en prod: probar en branch de Supabase, verificar tiempo de lock en tabla con datos.
