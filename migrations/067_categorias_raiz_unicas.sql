-- 067 — el índice único NO protegía las categorías raíz (auditoría CTO 2026-08-10, hallazgo B26).
--
-- EL AGUJERO, medido contra prod antes de escribir esto:
--
--   CREATE UNIQUE INDEX categorias_usuario_usuario_id_nombre_padre_id_key
--     ON public.categorias_usuario USING btree (usuario_id, nombre, padre_id)
--
-- Sin `NULLS NOT DISTINCT`. Y **todas las raíces tienen `padre_id IS NULL`**, así que para
-- Postgres dos raíces con el mismo `(usuario_id, nombre)` son filas DISTINTAS y el índice las
-- deja pasar. O sea que el único índice que parecía cubrir las categorías cubre exactamente las
-- subcategorías y ninguna raíz. Es la razón por la que el bug histórico pudo existir: dos
-- "Viajes" duplicados se volvieron 24 sin que la DB dijera nada (ver `buscarCategoriaRaiz`).
--
-- El fix de aquel momento fue de aplicación (`.single()` → `.limit(1)`), que corta el CICLO pero
-- no impide el primer duplicado. La defensa de integridad nunca existió.
--
-- POR QUÉ AHORA. B26 hace que el backend cree categorías CANÓNICAS por su cuenta cuando le
-- faltan al usuario, y hay dos escritores que pueden llegar a la vez a la misma raíz:
-- `asegurarCategoriaUsuario` y `crearSubcategoriaLibreUsuario` (que crea el padre si no lo
-- encuentra). El código los encadena, pero encadenar solo resuelve la carrera DENTRO de un
-- mensaje: dos gastos seguidos de la misma categoría, o dos webhooks de Meta al hilo, siguen
-- pudiendo cruzarse. Lo único que cierra la clase entera es la DB.
--
-- SE PUEDE APLICAR SIN LIMPIAR NADA: verificado el 2026-08-11, hay **0 pares**
-- `(usuario_id, nombre)` repetidos entre las raíces. (Sí hay 1 par que difiere solo en
-- mayúsculas; este índice es case-sensitive a propósito y no lo toca — ese es otro hallazgo,
-- el de los casi-duplicados, y mezclarlo acá haría fallar la migración por un problema distinto.)
--
-- Recomprobar antes de aplicar, en vez de creerle a este comentario:
--   select usuario_id, nombre, count(*) from categorias_usuario
--   where padre_id is null group by 1,2 having count(*) > 1;
--
-- QUÉ PASA CUANDO DISPARA: el insert devuelve 23505. Los tres escritores del backend
-- (`crearCategoriaLibreUsuario`, `crearSubcategoriaLibreUsuario`, `asegurarCategoriaUsuario`)
-- están envueltos en try/catch y no rompen el flujo del gasto — el usuario registra igual, que
-- es la regla que no se negocia. La webapp ya maneja el 23505 con un 409 con gracia
-- (`webapp/src/app/api/categories/route.ts`).

create unique index if not exists categorias_usuario_raiz_unica
  on public.categorias_usuario (usuario_id, nombre)
  where padre_id is null;

comment on index public.categorias_usuario_raiz_unica is
  'B26/2026-08-11: el índice (usuario_id,nombre,padre_id) NO cubre las raíces, porque padre_id '
  'es NULL en todas y Postgres trata los NULL como distintos. Este parcial es el que impide dos '
  'raíces con el mismo nombre para un usuario. Case-sensitive a propósito.';
