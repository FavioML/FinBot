-- 025_recurrentes_overrides.sql
-- Overrides de usuario sobre la detección de Suscripciones y Pagos Recurrentes del
-- dashboard webapp. La detección es heurística (agrupa por comercio + monto + cadencia);
-- esta tabla deja que el usuario corrija y que la corrección se recuerde (pasado y futuro):
--   - alias:    id_canonico  → unir variantes con nombres distintos ("Juno Luya E." == "Alquiler")
--   - renombre: label_canonico
--   - ocultar:  oculto        → no es recurrente / falso positivo
--   - forzar:   es_recurrente_manual → marcar recurrente algo no detectado
--   - catálogo: catalog_id    → forzar un servicio (split "APPLE.COM/BILL" → Apple Music / iCloud)
--   - plan:     plan_nombre   → plan elegido (ej. Claude Max)
--
-- clave_variante = comercio normalizado (lowercase+trim) o el catalog id, según el dominio.
-- dominio distingue la sección: 'recurrente' (pagos recurrentes) vs 'suscripcion'.
--
-- Aislamiento: recurrentes_overrides.usuario_id → usuarios.id, pero el JWT trae
-- auth.uid() = usuarios.supabase_auth_id. Mapeo vía subquery a usuarios (mismo patrón que
-- neto_scores/transacciones). La webapp LEE con el browser client (anon + cookie, RLS
-- aplica) y ESCRIBE con service-role vía /api/recurring/override (bypass RLS).
--
-- Tabla nueva y vacía: additive, sin lock sobre tablas con data. Idempotente.

CREATE TABLE IF NOT EXISTS public.recurrentes_overrides (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id           uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  dominio              text NOT NULL CHECK (dominio IN ('recurrente', 'suscripcion')),
  clave_variante       text NOT NULL,
  id_canonico          text,
  label_canonico       text,
  oculto               boolean NOT NULL DEFAULT false,
  es_recurrente_manual boolean,
  catalog_id           text,
  plan_nombre          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, dominio, clave_variante)
);

-- Listado de overrides del usuario por sección (WHERE usuario_id + dominio)
CREATE INDEX IF NOT EXISTS idx_recurrentes_overrides_user
  ON public.recurrentes_overrides (usuario_id, dominio);

-- Resolución de aliases: dado un id_canonico, traer sus variantes
CREATE INDEX IF NOT EXISTS idx_recurrentes_overrides_canonico
  ON public.recurrentes_overrides (usuario_id, dominio, id_canonico)
  WHERE id_canonico IS NOT NULL;

ALTER TABLE public.recurrentes_overrides ENABLE ROW LEVEL SECURITY;

-- SELECT propio (rol authenticated, lectura client-side vía browser client).
DROP POLICY IF EXISTS recurrentes_overrides_select_own ON public.recurrentes_overrides;
CREATE POLICY recurrentes_overrides_select_own
  ON public.recurrentes_overrides FOR SELECT
  TO authenticated
  USING (
    usuario_id IN (
      SELECT id FROM public.usuarios WHERE supabase_auth_id = (SELECT auth.uid())
    )
  );

-- Escritura full por service-role (las mutaciones van por /api/recurring/override).
DROP POLICY IF EXISTS recurrentes_overrides_all_service ON public.recurrentes_overrides;
CREATE POLICY recurrentes_overrides_all_service
  ON public.recurrentes_overrides FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
