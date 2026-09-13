// El detector de copy de `qa-bsuid-alta.mjs` (`qa-e2e/lib/copy-sin-numero.mjs`).
//
// Existe porque cada versión del detector se evadió con la frase siguiente: tres revisiones
// adversariales seguidas el 12-sep ("nro.", "cel", un número con puntos; después "tu wsp",
// "númer0", dígitos de ancho completo o en keycap, un fijo de 7 dígitos, un número en el path de
// un link; después "¿a qué número te escribo?", "[object Promise]", un número en el host o en el
// fragmento). Es una ALARMA sobre formas conocidas, no una prueba (ver el encabezado del módulo):
// este archivo fija cada evasión encontrada, el copy REAL del alta que no puede marcar, y los
// límites declarados, para que se vean.
//
// Los números de las evasiones son AJENOS (987654321). No uses 933014505 ni 970398192: son el bot
// y el Yape de Neto, exentos a propósito, y una evasión con ellos pasa por la excepción y no por
// el detector (ya pasó: nueve casos "rojos" que en realidad eran fixtures mal elegidas).

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { problemasDeCopy } from '../qa-e2e/lib/copy-sin-numero.mjs';

const ID = { bsuid: 'PE.qaaltaabc123def456', sufijo: 'abc123def456' };
// Armados con fromCharCode y no escritos: la capa que genera los archivos se come los escapes.
const ANCHO_CERO = String.fromCharCode(0x200b);
const KEYCAP = (d) => d + String.fromCharCode(0xfe0f, 0x20e3);
const ANCHO_COMPLETO = (s) => s.split('').map((d) => String.fromCharCode(0xff10 + Number(d))).join('');

const DEBE_MARCAR = [
  // primera revisión
  'Escríbeme tu número', 'Pásame tu nro. porfa', 'Dame tu cel', 'tu móvil, porfa', '987.654.321',
  '(01) 555-1234', 'Entra a https://x.pe/?tel=51987654321', '¡Hola !', 'Hola [object Object]',
  'Tu código: pe.QAALTA1234abcd',
  // segunda revisión
  'Escríbeme tu númer0', '¿Cuál es tu WhatsApp?', 'mándame tu wsp', 'pásame tu celu', 'tu telf. por favor',
  'tu núm. por favor', 'déjame tu # y te escribo', 'tu fijo también sirve', 'pásame tu cell',
  '987·654·321', '987,654,321', '987–654–321', ANCHO_COMPLETO('987654321'), '987654321'.split('').map(KEYCAP).join(''), '555-1234',
  'Vincula en https://app.neto.pe/vincular/51987654321', 'Escríbeme a https://wa.me/51987654321',
  'Tu referencia es abc123def456', 'Hola  Ana', '¡Listo, **!', 'Lo anoté como __', 'Te llamo “”',
  'Hola undefined', 'número de teléfono, porfa', 'Tu número es 987654321', 'Escríbeme ｔｕ ｎúｍｅｒｏ',
  // tercera revisión
  '¿A qué número te escribo?', '¿Me pasas tu contacto de WhatsApp?', 'Compárteme tu cuenta de WhatsApp y te aviso',
  '¿Me confirmas a qué celular te aviso?', 'Mándame tu numerito', 'Déjame tu nùmero', 'Escríbeme tu nú' + ANCHO_CERO + 'mero',
  '✅ Anotado: [object Promise]', '✅ S/12.50 en Transporte · Invalid Date', '987•654•321', '987:654:321',
  'Yapea al $ 987 654 321', 'https://app.neto.pe/vincular#51987654321', 'https://51987654321.neto.pe/',
  'https://app.neto.pe/v/519-876-543-21', 'https://app.neto.pe/activar?t=51987654321', 'Te llamo «»', 'Te llamo ()',
  'Anotado como:',
];

// Lo que el detector NO ve, a propósito y dicho. Si un día empieza a marcarlos, mejor: bórralos de acá.
const LIMITES_DECLARADOS = ['987 G54 32l', 'Tu referencia termina en …def456'];

// Copy real, tal como sale del código. El último caso comprueba que estos textos siguen existiendo
// en el fuente: si alguien cambia el copy, este archivo tiene que enterarse.
const COPY_REAL = [
  '👋 ¡Hola! Soy *NETO*, tu asistente financiero por WhatsApp.\n\n¿Cómo te llamas?\n\n_O dime *saltar* si prefieres ir directo._',
  '👋 ¡Hola! Soy *NETO*, tu asistente financiero.\n\n¿Cómo te llamas?\n\n_O dime *saltar* y empezamos de una._',
  'No pillé tu nombre. 🤔\n\nEscríbelo solito (ej: _"María"_) o dime *saltar* y empezamos de una.',
  '¡Listo, *Ana*! 🤝\n\nAnótame tu primer gasto y te muestro cómo funciono:\n\n📝 _"gasté 20 en taxi"_\n📸 O mándame la foto de un Yape o Plin\n\n_Lo que sea, del monto que sea._',
  '¡Listo! 🤝\n\nAnótame tu primer gasto y te muestro cómo funciono:\n\n📝 _"gasté 20 en taxi"_\n📸 O mándame la foto de un Yape o Plin\n\n_Lo que sea, del monto que sea._',
  '✅ S/12.50 en Transporte > Taxi · 12-sep-26\n\n─────\n🎁 Acabas de estrenar *Neto Pro*: 14 días con todo abierto — gráficos, categorías, reportes e historial completo.\n\nActívalo con un toque, sin contraseñas:\nhttps://app.neto.pe/activar?t=eyJ1Ijo1234567890abc.9876543210',
  'Activa tu cuenta y desbloquéalos: gráficos, presupuestos, historial y reportes. Además tu data queda respaldada si cambias de teléfono.',
  '✅ S/100000.00 en Vivienda > Alquiler · 01-sep-26',
  'Este mes llevas *$1,234,567.00* en 12 movimientos.',
  // falsos positivos que encontró la tercera revisión: el Yape de Neto, y los ejemplos en cursiva seguidos
  '✅ Plan *mensual* (S/10/mes).\n\n📲 Yapea S/10 al *970398192* (Favio Mendoza) y envíame la captura aquí. 📸',
  '🎉 *¡Genial!*\n\n📲 *Yapea al:* 970398192\n👤 *A nombre de:* Favio Mendoza\n\nDespués envíame la captura del Yape aquí. 📸',
  'Listo, Ana. Ya estoy trabajando por ti.\n\nEscribeme como quieras:\n_"cuanto gaste esta semana"_\n_"como va mi delivery"_\n_"dame mi reporte"_\n\n¿Por donde empezamos?',
];

describe('copy-sin-numero: el detector del copy del alta por BSUID', () => {
  it('marca cada evasión que encontraron las tres revisiones', () => {
    expect(DEBE_MARCAR.length).toBeGreaterThanOrEqual(55);
    const pasan = DEBE_MARCAR.filter((t) => problemasDeCopy(t, ID).length === 0);
    expect(pasan).toEqual([]);
  });

  it('no marca el copy real del alta', () => {
    const marcados = COPY_REAL.map((t) => [t.slice(0, 60), problemasDeCopy(t, ID)]).filter(([, p]) => p.length);
    expect(marcados).toEqual([]);
  });

  it('los límites declarados siguen siendo límites (si esto falla, el detector mejoró: actualizá la lista)', () => {
    expect(LIMITES_DECLARADOS.filter((t) => problemasDeCopy(t, ID).length > 0)).toEqual([]);
  });

  it('el copy real de arriba sigue existiendo en el código', () => {
    const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');
    const fuente = ['handlers/onboarding.js', 'lib/activacion.js', 'lib/trial.js']
      .map((f) => fs.readFileSync(path.join(raiz, f), 'utf8')).join('\n');
    for (const fragmento of [
      'tu asistente financiero por WhatsApp.', '¿Cómo te llamas?', 'No pillé tu nombre.',
      'Anótame tu primer gasto y te muestro cómo funciono', 'O mándame la foto de un Yape o Plin',
      'Actívalo con un toque, sin contraseñas', 'si cambias de teléfono',
      'al *970398192* (Favio Mendoza)', '*Yapea al:* 970398192', 'Ya estoy trabajando por ti.', '_"como va mi delivery"_',
    ]) {
      expect(fuente.includes(fragmento), fragmento).toBe(true);
    }
  });
});
