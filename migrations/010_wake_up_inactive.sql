-- Migration 010: agregar wake_up_inactive al enum de survey events
-- y extender el unique partial index para que sea one-shot por usuario.
--
-- Contexto: los reminder_d3/d7/d14/d30 son ventanas estrechas para usuarios
-- nuevos. wake_up_inactive cubre el gap de usuarios viejos (≥30d desde
-- registro) que llevan ≥30 dias sin transacciones.
--
-- One-shot: cada usuario recibe el wake-up MAXIMO una vez en su vida util,
-- garantizado a nivel DB con el unique partial index.

-- Agregar el nuevo valor al enum
ALTER TYPE survey_event_type ADD VALUE IF NOT EXISTS 'wake_up_inactive';

-- Postgres requiere commit antes de usar el valor nuevo en otro statement,
-- por eso esto va en migration aparte (no en el seed)
