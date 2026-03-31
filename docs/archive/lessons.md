# tasks/lessons.md — Lecciones aprendidas

## Lección 1 — Nunca pushear archivos >10KB via GitHub API
**Error**: Intenté subir index.js (90KB) via `github:push_files` y `github:create_or_update_file`.
El resultado fue un archivo truncado de 429 bytes en producción que rompió Railway.
**Regla**: Para archivos grandes, siempre editar en el filesystem del usuario con `Filesystem:edit_file`
y hacer `git push` desde la terminal del usuario. Nunca usar la API de GitHub para archivos grandes.

## Lección 2 — Patches con texto que tiene acentos/encoding especial
**Error**: Los patches generados con string literals en JS fallaban porque los acentos (á, é, ó)
en el archivo corrupto (UTF-8 mal guardado desde PowerShell) no coincidían con el texto del patch.
**Regla**: Para modificar index.js, usar Python con `open(path, 'r', encoding='utf-8')` que maneja
los bytes corruptos correctamente. Nunca asumir que el texto del archivo coincide exactamente con
lo que se ve — leer primero con `Filesystem:copy_file_user_to_claude` y verificar.

## Lección 3 — Aplicar múltiples patches al mismo archivo en la misma sesión
**Error**: Aplicar patch A, luego patch B buscando el texto de antes de patch A — falla porque
el texto ya cambió. Los patches dependientes deben aplicarse en cadena leyendo el estado actual
después de cada uno, no en paralelo.
**Regla**: Siempre `Filesystem:copy_file_user_to_claude` antes de cada patch para leer el estado
real del archivo. Nunca asumir que el archivo tiene el contenido de una edición anterior.

## Lección 4 — git rebase --abort antes de cualquier operación de sync
**Error**: `git pull --rebase` con historial divergente creó conflictos de merge en index.js.
El rebase quedó pendiente y bloqueó todos los pushes siguientes.
**Regla**: Si hay incertidumbre sobre el estado del historial git, siempre:
1. `git rebase --abort` primero (no falla si no hay rebase pendiente)
2. `git fetch origin` para ver el estado real del remoto
3. `git reset --hard HEAD` para limpiar el estado local
4. `git push --force origin main` solo cuando local > remoto en contenido

## Lección 5 — Verificar duplicados antes de aplicar cualquier patch
**Error**: El patch de CATEGORIAS_VALIDAS se aplicó dos veces porque no verificamos si ya existía.
Result: dos definiciones de const en el mismo scope, Node.js arranca con la segunda (silenciosamente).
**Regla**: Antes de cada patch, grep el archivo para verificar que el bloque a insertar no existe ya:
`grep -n "CATEGORIAS_VALIDAS\|normalizarCategoria" index.js`
