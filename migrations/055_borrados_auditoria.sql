-- Rastro de los borrados duros sobre la data de plata del usuario.
--
-- POR QUÉ. El 01-ago-2026 desaparecieron las transacciones y las deudas de un
-- usuario que paga y la causa no se pudo determinar. No porque faltara esfuerzo:
-- faltaba evidencia. `transacciones_eliminadas` solo guarda el borrado SUAVE que
-- hace el producto, así que un DELETE duro no deja nada; el WAL con `replica
-- identity = default` solo registra la PK; `pageinspect` necesita superuser y
-- Supabase no lo da. El único camino fue clonar el backup diario, y aun así el
-- restore quedó incompleto sin que nadie pudiera notarlo.
--
-- Este trigger es la caja negra que faltaba. NO bloquea nada — bloquear desde la
-- DB significaría distinguir al backend del SQL ad-hoc, y los dos entran con
-- service_role, así que cualquier regla se comería escrituras legítimas del
-- producto. Lo que hace es que la próxima vez la pregunta "quién borró esto" se
-- conteste con un SELECT en vez de con un día de trabajo.
--
-- Alcance a propósito: `transacciones`, `deudas` y `deuda_abonos`. Son las tres
-- tablas donde una fila perdida es plata que el usuario no puede reconstruir de
-- memoria. `categorias_usuario` y `presupuestos` quedan fuera porque el wipe de
-- onboarding las borra de forma rutinaria y solo generarían ruido; si alguna vez
-- hacen falta, es una línea más abajo.
--
-- El costo es una fila por borrado. Los borrados en estas tablas son raros (el
-- camino normal del producto es el borrado suave), y el cascade de limpiar un
-- usuario throwaway de QA escribe unas pocas decenas. No hay retención
-- automática: si algún día molesta, un DELETE por `borrado_at` la poda.

CREATE TABLE IF NOT EXISTS public.borrados_auditoria (
  id          bigserial PRIMARY KEY,
  borrado_at  timestamptz NOT NULL DEFAULT now(),
  tabla       text        NOT NULL,
  usuario_id  uuid,
  fila_id     text,
  fila        jsonb       NOT NULL,
  -- Quién. `db_user` distingue poco (casi todo entra como service_role), así que
  -- lo que de verdad separa al backend del SQL a mano es `contexto`:
  -- application_name lo setea cada cliente, y request.* lo setea PostgREST por
  -- request (o sea: si hay request.path, vino por la API, no por el editor SQL).
  db_user     text        NOT NULL,
  contexto    jsonb       NOT NULL
);

COMMENT ON TABLE public.borrados_auditoria IS
  'Append-only. Una fila por cada DELETE duro sobre transacciones/deudas/deuda_abonos, con la fila completa en `fila` para poder reinsertarla. Ver migrations/055.';

CREATE INDEX IF NOT EXISTS idx_borrados_auditoria_at ON public.borrados_auditoria (borrado_at DESC);
CREATE INDEX IF NOT EXISTS idx_borrados_auditoria_usuario ON public.borrados_auditoria (usuario_id, borrado_at DESC);

CREATE OR REPLACE FUNCTION public.audit_borrado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j jsonb := to_jsonb(OLD);
BEGIN
  INSERT INTO public.borrados_auditoria (tabla, usuario_id, fila_id, fila, db_user, contexto)
  VALUES (
    TG_TABLE_NAME,
    -- deuda_abonos no tiene usuario_id propio: se resuelve por la deuda padre,
    -- que es justo lo que uno quiere buscar cuando investiga.
    COALESCE(
      NULLIF(j ->> 'usuario_id', '')::uuid,
      (SELECT d.usuario_id FROM public.deudas d WHERE d.id = NULLIF(j ->> 'deuda_id', '')::uuid)
    ),
    j ->> 'id',
    j,
    current_user,
    jsonb_strip_nulls(jsonb_build_object(
      'app_name',     NULLIF(current_setting('application_name', true), ''),
      'client_addr',  host(inet_client_addr()),
      'req_method',   NULLIF(current_setting('request.method', true), ''),
      'req_path',     NULLIF(current_setting('request.path', true), ''),
      -- PostgREST movió los claims de GUCs sueltos a un JSON; se leen los dos
      -- porque el `true` de missing_ok hace que el que no exista devuelva null.
      'jwt_role',     COALESCE(
                        NULLIF(current_setting('request.jwt.claim.role', true), ''),
                        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
                      )
    ))
  );
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.audit_borrado() IS
  'Trigger AFTER DELETE: copia la fila borrada a borrados_auditoria. No bloquea; solo deja rastro.';

DROP TRIGGER IF EXISTS trg_audit_borrado ON public.transacciones;
CREATE TRIGGER trg_audit_borrado
  AFTER DELETE ON public.transacciones
  FOR EACH ROW EXECUTE FUNCTION public.audit_borrado();

DROP TRIGGER IF EXISTS trg_audit_borrado ON public.deudas;
CREATE TRIGGER trg_audit_borrado
  AFTER DELETE ON public.deudas
  FOR EACH ROW EXECUTE FUNCTION public.audit_borrado();

DROP TRIGGER IF EXISTS trg_audit_borrado ON public.deuda_abonos;
CREATE TRIGGER trg_audit_borrado
  AFTER DELETE ON public.deuda_abonos
  FOR EACH ROW EXECUTE FUNCTION public.audit_borrado();

-- Append-only de verdad: nadie de la aplicación puede editar ni borrar el rastro.
-- El INSERT lo hace el trigger, que es SECURITY DEFINER y corre como su dueño, así
-- que revocar INSERT acá no lo rompe. Solo el rol `postgres` (dashboard/migración)
-- puede tocar la tabla, que es exactamente lo que se quiere: si alguien la limpia,
-- fue una acción deliberada de administración, no un bug de un harness.
ALTER TABLE public.borrados_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.borrados_auditoria FROM public, anon, authenticated, service_role;
GRANT SELECT ON public.borrados_auditoria TO service_role;
REVOKE ALL ON SEQUENCE public.borrados_auditoria_id_seq FROM public, anon, authenticated, service_role;
