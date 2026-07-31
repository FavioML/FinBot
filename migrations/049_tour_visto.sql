-- Gate server-side del tour de onboarding de la webapp (el modal de 4 pasos del dashboard).
--
-- Antes el tour se marcaba solo en localStorage (`neto_tour_v2`): se veía una vez POR
-- NAVEGADOR, así que reaparecía en otro navegador/dispositivo/incógnito. Ahora la marca
-- vive en la cuenta: se muestra una sola vez POR USUARIO y no vuelve en ningún lado.
--
-- El front sigue leyendo también el localStorage como fast-path: un usuario que YA cerró el
-- tour (localStorage seteado, pero esta columna arranca en false) NO lo vuelve a ver — el
-- OR de ambas señales lo suprime. Así el rollout no re-dispara el tour a los que ya lo vieron.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tour_visto boolean NOT NULL DEFAULT false;
