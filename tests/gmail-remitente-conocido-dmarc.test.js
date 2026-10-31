import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { leerCorreosDesdeCuenta } = require('../gmail.js');
const log = require('../lib/logger');
const errorMonitor = require('../lib/error-monitor');

/**
 * **Un From falsificado de un remitente CONOCIDO no se convierte en gasto si Gmail dice
 * `dmarc=fail`.**
 *
 * Los remitentes de `REMITENTES_BANCARIOS` entran sin mirar la firma, por la decisión que documenta
 * `esCorreoMasivo`: no se vieron los headers reales de un aviso de BCP ni de Yape, y exigirles algo
 * a ciegas arriesga perder gastos reales en silencio. Hasta el 31-oct-2026 eso dejaba entrar
 * cualquier correo que dijera venir de esas direcciones (`docs/DEFECTOS.md`, fila del 30-oct,
 * punto abierto 1).
 *
 * Lo que sí se puede exigir sin ver esos headers es la evidencia POSITIVA de falsificación: el
 * `dmarc=fail` que escribe Gmail al recibir. Un aviso real del banco no lo trae, y con
 * p=quarantine o p=reject el que lo trae ya cae en spam y `messages.list` ni lo lista; con p=none
 * (Ripley) Gmail lo deja en la bandeja y este filtro es lo único que lo frena.
 *
 * Mismo doble de transporte que `gmail-remitente-desconocido-dkim.test.js`.
 */

const ES_LIST = (url) => /\/messages\?/.test(url) || /\/messages$/.test(url);
const ES_GET = (url) => /\/messages\/[^/]+$/.test(url);

const CUERPO = 'Realizaste un consumo de S/ 480.00 en SAGA FALABELLA con tu Tarjeta de Credito BCP';
const MOTIVO = 'Correo de remitente conocido con dmarc=fail ignorado';
const MOTIVO_DKIM = 'Correo de remitente desconocido sin DKIM bancario ignorado';

function correo(id, headersExtra) {
  return {
    id,
    internalDate: String(Date.now()),
    snippet: 'Realizaste un consumo',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Subject', value: 'Realizaste un consumo con tu Tarjeta' }, ...headersExtra],
      body: { data: Buffer.from(CUERPO).toString('base64') },
    },
  };
}

function transporteCon(msg) {
  return {
    request: async (opts) => {
      const url = String(opts.url || '');
      if (ES_LIST(url)) return { data: { messages: [{ id: msg.id }] } };
      if (!ES_GET(url)) throw new Error('llamada inesperada a la API de Gmail: ' + url);
      return { data: msg };
    },
  };
}

const leer = (msg) => leerCorreosDesdeCuenta(transporteCon(msg), 'a@b.com', ['notificaciones@notificacionesbcp.com.pe']);

const FROM = (v) => ({ name: 'From', value: v });
const AR = (v) => ({ name: 'Authentication-Results', value: v });
const BCP = 'BCP <notificaciones@notificacionesbcp.com.pe>';

// Forma del header de Gmail ante un From falsificado. NO es copia de un correo real.
const AR_FALLA = (politica = 'QUARANTINE', dominio = 'notificacionesbcp.com.pe') =>
  `mx.google.com;\r\n       spf=pass (google.com: domain of x@evil.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@evil.com;\r\n       dmarc=fail (p=${politica} sp=${politica} dis=${politica === 'NONE' ? 'NONE' : politica}) header.from=${dominio}`;

let warn;
let registrarError;
beforeEach(() => {
  warn = vi.spyOn(log, 'warn');
  registrarError = vi.spyOn(errorMonitor, 'registrarError').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

async function esperarDescartePorDmarc(msg) {
  const r = await leer(msg);
  expect(r.mensajes).toHaveLength(0);
  expect(r.salteados).toBe(0);
  expect(warn.mock.calls.some(([, m]) => m === MOTIVO), 'no cayó por el filtro DMARC').toBe(true);
  return r;
}

async function esperarQueEntre(msg) {
  const r = await leer(msg);
  expect(r.mensajes).toHaveLength(1);
}

describe('remitente conocido con dmarc=fail de Gmail: se descarta', () => {
  it('con p=quarantine', async () => {
    await esperarDescartePorDmarc(correo('d1', [FROM(BCP), AR(AR_FALLA())]));
  });

  it('con p=none, el caso que Gmail deja en la bandeja (Banco Ripley)', async () => {
    await esperarDescartePorDmarc(correo('d2', [FROM('Banco Ripley <alertas@bancoripley.com.pe>'),
      AR(AR_FALLA('NONE', 'bancoripley.com.pe'))]));
  });

  it('sin importar mayúsculas', async () => {
    await esperarDescartePorDmarc(correo('d3', [FROM(BCP), AR('mx.google.com; DMARC=FAIL (p=REJECT) header.from=notificacionesbcp.com.pe')]));
  });

  it('aunque un header de más abajo diga dmarc=pass (manda el de arriba)', async () => {
    await esperarDescartePorDmarc(correo('d4', [AR(AR_FALLA()), FROM(BCP),
      AR('mx.google.com; dkim=pass header.d=notificacionesbcp.com.pe; dmarc=pass header.from=notificacionesbcp.com.pe')]));
  });

  it('aunque el sobre SMTP abra un comentario que se traga la cláusula', async () => {
    // `MAIL FROM:<"a(b"@evil.com>`: dentro de un comentario las comillas no cuentan, así que el
    // `(` de la parte local deja el comentario del SPF sin cerrar y un parser por cláusulas no
    // vería el `dmarc=fail`. Por eso el filtro busca en el texto crudo: el atacante puede agregar
    // texto al header, pero no borrar el que escribe Gmail.
    await esperarDescartePorDmarc(correo('d5', [FROM(BCP),
      AR('mx.google.com; spf=pass (google.com: domain of "a(b"@evil.com designates 1.2.3.4 as permitted sender) smtp.mailfrom="a(b"@evil.com; dmarc=fail (p=QUARANTINE sp=QUARANTINE dis=QUARANTINE) header.from=notificacionesbcp.com.pe')]));
  });

  it('va a `errores` una vez por correo, sin asunto ni cuerpo', async () => {
    const msg = correo('d6-unico', [FROM(BCP), AR(AR_FALLA())]);
    await esperarDescartePorDmarc(msg);
    await leer(msg);
    expect(registrarError).toHaveBeenCalledTimes(1);
    expect(registrarError.mock.calls[0][0]).toBe('GMAIL_DMARC');
    const serializado = JSON.stringify(registrarError.mock.calls[0]);
    for (const s of ['480.00', 'Realizaste', 'Tarjeta', 'SAGA']) expect(serializado).not.toContain(s);
    expect(serializado).toContain('notificacionesbcp.com.pe');
    // El detalle es lo que separa "alguien imita al banco" de "un aviso real se perdió".
    expect(registrarError.mock.calls[0][2].detalle).toMatch(/dmarc=fail/);
  });

  it('un remitente DESCONOCIDO con dmarc=fail sigue por el filtro DKIM, sin fila en `errores`', async () => {
    // Un correo personal de un dominio con DMARC que falló es ruido: el filtro DKIM lo descarta y
    // no deja el dominio de un tercero en `errores` (eso solo pasa si parece de banco).
    const r = await leer(correo('d8', [FROM('Amigo <yo@ejemplo-personal.com>'), AR(AR_FALLA('REJECT', 'ejemplo-personal.com'))]));
    expect(r.mensajes).toHaveLength(0);
    expect(warn.mock.calls.some(([, m]) => m === MOTIVO_DKIM)).toBe(true);
    expect(warn.mock.calls.some(([, m]) => m === MOTIVO)).toBe(false);
    expect(registrarError).not.toHaveBeenCalled();
  });

  it('el log no lleva cuerpo, asunto ni la dirección', async () => {
    await esperarDescartePorDmarc(correo('d7', [FROM(BCP), AR(AR_FALLA())]));
    const serializado = JSON.stringify(warn.mock.calls.find(([, m]) => m === MOTIVO));
    for (const s of ['480.00', 'Realizaste', 'SAGA', 'notificaciones@']) expect(serializado).not.toContain(s);
  });
});

describe('remitente conocido sin evidencia de falsificación: entra como antes', () => {
  it('sin Authentication-Results', async () => {
    await esperarQueEntre(correo('p1', [FROM(BCP)]));
  });

  it('con dmarc=pass', async () => {
    await esperarQueEntre(correo('p2', [FROM(BCP),
      AR('mx.google.com; dkim=pass header.i=@notificacionesbcp.com.pe header.s=s1; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=notificacionesbcp.com.pe')]));
  });

  it('con resultados que no prueban nada (none, temperror, permerror, bestguesspass)', async () => {
    for (const res of ['none', 'temperror', 'permerror', 'bestguesspass', 'failover']) {
      await esperarQueEntre(correo('p3-' + res, [FROM(BCP), AR(`mx.google.com; spf=pass smtp.mailfrom=x.com; dmarc=${res} header.from=notificacionesbcp.com.pe`)]));
    }
  });

  it('con un dmarc=fail que no escribió Gmail (no es evidencia de Gmail)', async () => {
    await esperarQueEntre(correo('p4', [FROM(BCP), AR('relay.otro.com; dmarc=fail header.from=notificacionesbcp.com.pe')]));
  });

  it('con dkim=fail pero dmarc=pass (una firma rota no es falsificación si el SPF alinea)', async () => {
    await esperarQueEntre(correo('p5', [FROM(BCP),
      AR('mx.google.com; dkim=fail (bad signature) header.i=@notificacionesbcp.com.pe; spf=pass smtp.mailfrom=notificaciones@notificacionesbcp.com.pe; dmarc=pass header.from=notificacionesbcp.com.pe')]));
  });
});

describe('las direcciones retiradas de la lista ya no tienen exención', () => {
  // Dominios sin DMARC (o, tunki.pe, registrado a nombre de un particular): Gmail no puede dar
  // `dmarc=fail` sobre ellos, así que el único filtro que les aplica es el de remitentes
  // desconocidos, que exige DKIM alineado de un banco.
  for (const from of [
    'notificaciones.tarjetas@scotiabank.pe', 'alertas@scotiabank.pe', 'notificaciones@plin.pe',
    'noreply@tunki.pe', 'notificaciones@cmacpiura.com.pe', 'notificaciones@cajacusco.com.pe',
    'notificaciones@cajasullana.com.pe',
  ]) {
    it(from, async () => {
      const r = await leer(correo('r-' + from, [FROM(`Banco <${from}>`)]));
      expect(r.mensajes).toHaveLength(0);
      expect(warn.mock.calls.some(([, m]) => m === MOTIVO_DKIM), 'no cayó por el filtro DKIM').toBe(true);
    });
  }
});
