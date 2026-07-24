-- N1 (cto-audit barrido 2026-07-24): fija search_path de la funcion de conservacion.
-- El advisor de Supabase marca function_search_path_mutable en space_shares_conserve
-- (creada en la 035). El cuerpo solo usa objetos de pg_catalog (jsonb_typeof,
-- jsonb_array_elements, sum, round, operadores jsonb), asi que search_path='' es seguro:
-- no invalida la CHECK constraint space_expenses_split_snapshot_conserva (no cambia la
-- firma de la funcion) y elimina la ambiguedad de resolucion de nombres.
-- Aplicada a prod via Supabase MCP el 2026-07-24; este archivo mantiene repo==prod.
alter function public.space_shares_conserve(jsonb, numeric) set search_path = '';
