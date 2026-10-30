import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { leerCorreosDesdeCuenta, direccionDe } = require('../gmail.js');
const log = require('../lib/logger');
const errorMonitor = require('../lib/error-monitor');

/**
 * **Un correo que IMITA un aviso del BCP desde un remitente desconocido no se convierte en gasto.**
 *
 * `construirQueriesBancarias` arma una segunda query por frases ("realizaste un consumo",
 * "yapaste", "transferencia realizada"...) que lista correos de CUALQUIER remitente. Hasta el
 * 30-oct-2026, para un remitente fuera de `REMITENTES_BANCARIOS` el único filtro era
 * `esCorreoMasivo`, que mira headers de envío masivo: un correo SUELTO escrito por cualquiera
 * ("Realizaste un consumo de S/ 480.00 en ...") pasaba los tres filtros y gpt-4o-mini lo
 * registraba en el dashboard de un usuario Pro como transacción real. Es inyección indirecta:
 * texto no confiable llegando a un modelo cuya salida escribe datos.
 *
 * El discriminador es de TRANSPORTE, como en `esCorreoMasivo`: la firma DKIM que Gmail verificó
 * al recibir, alineada con el From (`lib/auth-results.js`). Un tercero puede escribir cualquier
 * From y cualquier cuerpo, pero no firmar con la clave de `bcp.com.pe`, y si pone un From del
 * banco, Gmail le aplica el DMARC del banco.
 *
 * **Lo que esto NO cubre, y está en `docs/DEFECTOS.md`:** los remitentes conocidos siguen
 * entrando sin mirar la firma (decisión documentada en `esCorreoMasivo`), y el replay de un aviso
 * real del propio atacante, que lleva una firma válida del banco.
 *
 * Mismo doble de transporte que `gmail-listado-fallido.test.js`: se ataca `auth.request`, así que
 * corre el camino real de `leerCorreosDesdeCuenta` sin mockear `googleapis` ni salir a la red.
 */

const ES_LIST = (url) => /\/messages\?/.test(url) || /\/messages$/.test(url);
const ES_GET = (url) => /\/messages\/[^/]+$/.test(url);

const CUERPO = 'Realizaste un consumo de S/ 480.00 en SAGA FALABELLA con tu Tarjeta de Credito BCP';
const MOTIVO = 'Correo de remitente desconocido sin DKIM bancario ignorado';

function correo(id, headersExtra) {
  return {
    id,
    internalDate: String(Date.now()),
    snippet: 'Realizaste un consumo',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Realizaste un consumo con tu Tarjeta' },
        ...headersExtra,
      ],
      body: { data: Buffer.from(CUERPO).toString('base64') },
    },
  };
}

/** `authClient` falso que lista UN id y devuelve `msg` en el get. */
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
const DESCONOCIDO = 'BCP Notificaciones <avisos@bcp-alertas-seguras.com>';

// Forma del header que Gmail antepone al recibir, con el `header.i` que usa Gmail. NO es una
// copia de un aviso real del BCP: esos headers no se inspeccionaron.
const AR_BCP = 'mx.google.com;\r\n       dkim=pass header.i=@notificacionesbcp.com.pe header.s=s1 header.b=AbCdEf12;\r\n       spf=pass (google.com: domain of notificaciones@notificacionesbcp.com.pe designates 200.37.1.1 as permitted sender) smtp.mailfrom=notificaciones@notificacionesbcp.com.pe;\r\n       dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=notificacionesbcp.com.pe';

let warn;
let registrarError;
beforeEach(() => {
  warn = vi.spyOn(log, 'warn');
  registrarError = vi.spyOn(errorMonitor, 'registrarError').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

/**
 * Un 0 en `mensajes` sale igual si el correo cayó por OTRO filtro o si el parser lanzó (el
 * `catch` del get suma a `salteados`). Este helper exige que haya caído por ESTE filtro.
 */
async function esperarDescartePorDkim(msg) {
  const r = await leer(msg);
  expect(r.mensajes).toHaveLength(0);
  expect(r.salteados).toBe(0);
  expect(warn.mock.calls.some(([, m]) => m === MOTIVO), 'no cayó por el filtro DKIM').toBe(true);
  return r;
}

describe('remitente desconocido: entra solo con DKIM alineado de un banco', () => {
  it('sin Authentication-Results se descarta (el caso del ataque)', async () => {
    await esperarDescartePorDkim(correo('x1', [FROM(DESCONOCIDO)]));
  });

  it('con DKIM válido de su propio dominio se descarta', async () => {
    await esperarDescartePorDkim(correo('x2', [FROM(DESCONOCIDO),
      AR('mx.google.com; dkim=pass header.i=@bcp-alertas-seguras.com header.s=k1 header.b=zz; spf=pass smtp.mailfrom=bcp-alertas-seguras.com; dmarc=pass header.from=bcp-alertas-seguras.com')]));
  });

  it('con DKIM del banco pero FALLIDO se descarta', async () => {
    await esperarDescartePorDkim(correo('x3', [FROM('BCP <avisos@bcp.com.pe>'),
      AR('mx.google.com; dkim=fail (bad signature) header.i=@bcp.com.pe header.s=s1 header.b=zz; spf=softfail smtp.mailfrom=bcp-alertas-seguras.com')]));
  });

  it('una firma del banco NO alcanza si el From es de otro dominio (alineación)', async () => {
    // Cubre lo que el parser no puede ver: un `dkim=pass header.d=bcp.com.pe` colado desde un
    // comentario, o un aviso real del banco firmado y reenviado con otro From.
    await esperarDescartePorDkim(correo('x4', [FROM(DESCONOCIDO),
      AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1')]));
  });

  it('una firma de OTRO banco no alinea', async () => {
    await esperarDescartePorDkim(correo('x5', [FROM('Interbank <avisos@interbank.pe>'),
      AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1')]));
  });

  it('el display name no compra la exención de remitente conocido', async () => {
    // El display name lo escribe quien manda. Gmail evalúa el DMARC contra la dirección REAL,
    // la de evil.com, que pasa. Hasta el 30-oct `direccionDe` tomaba el primer `<...>`.
    for (const from of [
      '"<notificaciones@notificacionesbcp.com.pe>" <x@evil.com>',
      'x@evil.com (<notificaciones@notificacionesbcp.com.pe>)',
      '<notificaciones@notificacionesbcp.com.pe> via <x@evil.com>',
      // Varios buzones: el DMARC puede evaluarse contra el primero, y tomar el último lo compraba.
      '<x@evil.com>, <notificaciones@notificacionesbcp.com.pe>',
      'x@evil.com, BCP <notificaciones@notificacionesbcp.com.pe>',
    ]) {
      warn.mockClear();
      await esperarDescartePorDkim(correo('x6', [FROM(from)]));
    }
  });

  it('un Authentication-Results que no escribió Gmail, o debajo del de Gmail, no cuenta', async () => {
    await esperarDescartePorDkim(correo('x7', [FROM('BCP <avisos@bcp.com.pe>'),
      AR('relay.atacante.com; dkim=pass header.d=bcp.com.pe header.s=s1')]));
    warn.mockClear();
    await esperarDescartePorDkim(correo('x8', [
      AR('mx.google.com; dkim=none; spf=pass smtp.mailfrom=bcp-alertas-seguras.com'),
      FROM('BCP <avisos@bcp.com.pe>'),
      AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1'),
    ]));
    // El de arriba manda aunque no sea de Gmail: buscar "el primero de mx.google.com" creería
    // uno escrito por el remitente más abajo.
    warn.mockClear();
    await esperarDescartePorDkim(correo('x8b', [
      AR('relay.atacante.com; dkim=none'),
      FROM('BCP <avisos@bcp.com.pe>'),
      AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1'),
    ]));
  });

  it('el descarte se loguea sin cuerpo, sin asunto y sin la dirección del remitente', async () => {
    await esperarDescartePorDkim(correo('x9', [FROM(DESCONOCIDO)]));
    const serializado = JSON.stringify(warn.mock.calls.find(([, m]) => m === MOTIVO));
    expect(serializado).not.toContain('480.00');
    expect(serializado).not.toContain('SAGA FALABELLA');
    expect(serializado).not.toContain('Realizaste');
    expect(serializado).not.toContain('avisos@');
    expect(serializado).toContain('bcp-alertas-seguras.com');
  });

  it('un From de banco descartado va a `errores`, una vez por correo y sin asunto ni cuerpo', async () => {
    // Dominio que ningún otro caso usa y id propio: el dedup es por correo, y si fuera por dominio
    // este caso no lo notaría si otro test llenó el registro antes.
    const msg = correo('x10-unico', [FROM('Mibanco <avisos@mibanco.com.pe>')]);
    await esperarDescartePorDkim(msg);
    await leer(msg);
    expect(registrarError).toHaveBeenCalledTimes(1);
    expect(registrarError.mock.calls[0][0]).toBe('GMAIL_DKIM');
    const serializado = JSON.stringify(registrarError.mock.calls[0]);
    for (const s of ['480.00', 'Realizaste', 'Tarjeta']) expect(serializado).not.toContain(s);
    const otro = correo('x10-otro', [FROM('Mibanco <avisos@mibanco.com.pe>')]);
    await leer(otro);
    expect(registrarError).toHaveBeenCalledTimes(2);
  });

  it('una firma válida de banco con un From que no se puede leer también va a `errores`', async () => {
    // Un aviso real en un formato de From que `direccionDe` no reconoce se perdería sin rastro.
    await esperarDescartePorDkim(correo('x12', [FROM('BCP <avisos@bcp.com.pe> (Banco de Credito)'),
      AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1')]));
    expect(registrarError).toHaveBeenCalledTimes(1);
  });

  it('un From que no es de banco NO va a `errores` (es el ruido esperado)', async () => {
    await esperarDescartePorDkim(correo('x11', [FROM(DESCONOCIDO)]));
    expect(registrarError).not.toHaveBeenCalled();
  });

  it('con DKIM alineado del banco entra, aunque la dirección no esté en la lista', async () => {
    const r = await leer(correo('ok1', [FROM('BCP <otra.direccion@notificacionesbcp.com.pe>'), AR(AR_BCP)]));
    expect(r.mensajes).toHaveLength(1);
  });

  it('acepta header.d, header.i, subdominios y la firma de BCP sobre un From de Yape', async () => {
    for (const [from, firma] of [
      ['avisos@yape.com.pe', 'header.d=yape.com.pe'],
      ['avisos@email.bcp.com.pe', 'header.d=bcp.com.pe'],
      ['avisos@yape.pe', 'header.i=@yape.pe'],
      ['avisos@yape.pe', 'header.d=bcp.com.pe'],
      ['avisos@BCP.COM.PE', 'HEADER.D=BCP.COM.PE'],
    ]) {
      const r = await leer(correo('ok2', [FROM(`Banco <${from}>`), AR(`mx.google.com; DKIM=PASS ${firma} header.s=s1 header.b=q`)]));
      expect(r.mensajes, `${from} / ${firma}`).toHaveLength(1);
    }
  });
});

describe('remitente conocido: el camino que hoy funciona no se toca', () => {
  it('entra sin Authentication-Results, como antes', async () => {
    const r = await leer(correo('k1', [FROM('BCP <notificaciones@notificacionesbcp.com.pe>')]));
    expect(r.mensajes).toHaveLength(1);
  });

  it('entra aunque el header venga como `FROM`', async () => {
    const r = await leer(correo('k2', [{ name: 'FROM', value: 'BCP <notificaciones@notificacionesbcp.com.pe>' }]));
    expect(r.mensajes).toHaveLength(1);
  });

  it('direccionDe sigue leyendo los formatos legítimos', () => {
    expect(direccionDe('"Servicio de Notificaciones BCP" <notificaciones@notificacionesbcp.com.pe>  ')).toBe('notificaciones@notificacionesbcp.com.pe');
    expect(direccionDe('BCP Comunica <bcpcomunica@email.bcp.com.pe>')).toBe('bcpcomunica@email.bcp.com.pe');
    expect(direccionDe('notificaciones@yape.pe')).toBe('notificaciones@yape.pe');
    expect(direccionDe('"BCP, Servicio \\"Alertas\\"" <Notificaciones@NotificacionesBCP.com.pe>')).toBe('notificaciones@notificacionesbcp.com.pe');
    expect(direccionDe('=?UTF-8?Q?Banco_de_Cr=C3=A9dito?= <notificaciones@notificacionesbcp.com.pe>')).toBe('notificaciones@notificacionesbcp.com.pe');
  });
});
