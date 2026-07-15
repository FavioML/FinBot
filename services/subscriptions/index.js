// Barrel del detector de suscripciones de terceros (Netflix, Spotify, ChatGPT, etc.).
// Preserva la superficie pública original de services/subscriptions.js tras la
// modularización en catalog.js (datos), detector.js (lógica) y format.js (WhatsApp).
//
// Contrato consumido por el backend:
//   - detectarSuscripciones(usuarioId) -> cron/checks.js y services/recommendations.js
//   - matchCatalogo / obtenerCatalogo / generarTextoSuscripciones: exportadas sin
//     consumidor actual en el backend (el webapp tiene su propia copia TS del catálogo).

const { CATALOGO_SUSCRIPCIONES, obtenerCatalogo } = require('./catalog');
const { matchCatalogo, detectarSuscripciones } = require('./detector');
const { generarTextoSuscripciones } = require('./format');

module.exports = {
  CATALOGO_SUSCRIPCIONES,
  matchCatalogo,
  detectarSuscripciones,
  obtenerCatalogo,
  generarTextoSuscripciones,
};
