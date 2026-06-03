// Helpers de fecha — siempre zona horaria Perú (America/Lima, UTC-5).
// Importante: usar estas funciones en lugar de `new Date().toISOString().split('T')[0]`
// porque toISOString() devuelve UTC y de noche en Lima ya es el día siguiente en UTC,
// lo que causa que registros del usuario se guarden con fecha del día siguiente.

const TZ = 'America/Lima';

/** Devuelve la fecha de hoy en Lima como YYYY-MM-DD. */
export function hoyPeru(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Devuelve un Date que representa "ahora" en hora Lima (útil para getMonth/getDate). */
export function ahoraPeru(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

/** Convierte un Date arbitrario a YYYY-MM-DD en zona Lima. */
export function fechaPeru(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}
