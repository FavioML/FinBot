// ¿Esta carga es una sonda de rendimiento y no una persona?
//
// PageSpeed ya no manda `Chrome-Lighthouse` en el UA, así que el filtro de bots de PostHog
// lo deja pasar y sus visitas entraban al proyecto como tráfico y como `$web_vitals` de
// campo. Dos formas:
//   - con cache-buster en la URL: `?cwv=` (measure-cwv-lab) y `?det=` (mediciones a mano);
//   - sin query, las del canary diario de CWV, con el UA fijo de emulación de Lighthouse.
//     Medido el 11-sep-2026 sobre 180 días y los cuatro hosts del proyecto: ese UA sale SOLO
//     en su forma exacta, siempre con un pageview y a la hora del canary. El Chrome real de
//     Android ya no manda modelo (reducción de UA); el navegador de Instagram sí, con `wv`.
//
// La misma regla vive en `landing/src/app/layout.tsx`. Son dos repos y no pueden compartir
// código, así que está duplicada a propósito, igual que las reglas de copy.
const MARCADOR = /[?&](cwv|det)=/
const UA_LIGHTHOUSE_MOVIL = 'Android 11; moto g power (2022)'

export function esSondaDeRendimiento(search: string, userAgent: string): boolean {
  return MARCADOR.test(search) || userAgent.includes(UA_LIGHTHOUSE_MOVIL)
}
