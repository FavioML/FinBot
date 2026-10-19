import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La telemetría del formulario de Nuevo gasto/ingreso, fijada por texto (acá no hay jsdom).
 *
 * **Por qué existe.** El 19-oct-2026 Favio no pudo registrar un gasto desde su iPhone: el diálogo
 * medía `92vh`, que en iOS es el alto con las barras del navegador escondidas, y "Registrar" quedaba
 * debajo de la pantalla. La webapp ya emitía `transaction_created` (desde junio), pero solo en el
 * éxito: un formulario al que no se le puede llegar al botón no deja NINGÚN rastro, igual que un
 * formulario que nadie abrió. Con `transaction_form_opened` como denominador, abiertos contra
 * creados por `$os` (que PostHog adjunta solo) muestra la caída por dispositivo; con
 * `transaction_create_failed` se separa "no llegó al botón" del rechazo del servidor.
 *
 * Lo que se fija:
 * 1. que los tres eventos existan una vez cada uno, que abrir no se emita al EDITAR (inflaría el
 *    denominador) ni en cada render, y que crear sólo salga en el éxito;
 * 2. que ningún payload lleve plata ni texto del usuario. Es una app financiera y PostHog es un
 *    tercero (babec96: el replay enmascara todo; un evento con el monto se saltaría esa máscara).
 *
 * Cómo, y por qué tan estricto: cada `track(` del archivo se parsea con paréntesis balanceados y
 * TIENE que parsear (un payload en una variable o un objeto anidado no se puede leer, y la primera
 * versión los dejaba pasar en silencio); y lo que se permite son PARES clave-valor, no claves, porque
 * `metodo_pago: form.metodo_pago + form.banco` o `status: await res.text()` cumplían la lista de
 * claves y mandaban el dato igual. Revisión adversarial del mismo día: 15 evasiones de 23.
 */

const SRC = readFileSync(join(process.cwd(), 'src/components/dashboard/transaction-form.tsx'), 'utf8');

/** Los argumentos de cada llamada `track(…)`, cortados por paréntesis balanceados. */
function llamadas(codigo: string): { args: string; en: number }[] {
  return [...codigo.matchAll(/\btrack\(/g)].map((m) => {
    let prof = 0, i = m.index! + 'track'.length;
    for (; i < codigo.length; i++) {
      if (codigo[i] === '(') prof++;
      else if (codigo[i] === ')' && --prof === 0) break;
    }
    return { args: codigo.slice(m.index! + 'track('.length, i), en: m.index! };
  });
}

/** Lo único que puede viajar, como par exacto. */
const VALORES: Record<string, string[]> = {
  tipo: ['tipo'],
  canal: ["'web'"],
  metodo_pago: ['form.metodo_pago'],
  status: ['res.status', "'red'"],
};

/** `{ evento, pares }`, o el motivo por el que esa llamada no se puede leer. */
function leer(args: string): { evento: string; pares: [string, string][] } | { error: string } {
  const m = args.match(/^\s*EVENTS\.([A-Z_]+)\s*,\s*\{([^{}]*)\}\s*$/);
  if (!m) return { error: `no es track(EVENTS.X, { … }) con un objeto literal plano: ${args.replace(/\s+/g, ' ').slice(0, 80)}` };
  const pares = m[2].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [k, ...v] = p.split(':');
    return [k.trim(), (v.length ? v.join(':') : k).trim()] as [string, string];
  });
  return { evento: m[1], pares };
}

function problemas(codigo: string): string[] {
  const out: string[] = [];
  if (/posthog|\.capture\(/i.test(codigo)) out.push('el formulario no habla con PostHog directo: sólo por track()');
  for (const { args } of llamadas(codigo)) {
    const r = leer(args);
    if ('error' in r) { out.push(r.error); continue; }
    for (const [k, v] of r.pares) if (!VALORES[k]?.includes(v)) out.push(`${r.evento}: ${k}: ${v}`);
    if (!r.pares.some(([k]) => k === 'canal')) out.push(`${r.evento}: sin canal`);
  }
  return out;
}

describe('telemetría del formulario de transacción', () => {
  const todas = llamadas(SRC).map((l) => ({ ...l, r: leer(l.args) }));
  const de = (ev: string) => todas.filter((l) => !('error' in l.r) && l.r.evento === ev);

  it('emite abrir y crear una vez, y fallar en sus dos ramas (antivacuidad)', () => {
    expect(de('TRANSACTION_FORM_OPENED')).toHaveLength(1);
    expect(de('TRANSACTION_CREATED')).toHaveLength(1);
    expect(de('TRANSACTION_CREATE_FAILED')).toHaveLength(2);
  });

  it('toda llamada se puede leer y sólo lleva pares permitidos', () => {
    expect(problemas(SRC)).toEqual([]);
  });

  it('el lector ve las formas que evadían la primera versión', () => {
    const conLlamada = (t: string) => problemas(`x(); ${t}; y();`);
    expect(conLlamada("track(EVENTS.TRANSACTION_CREATED, { tipo, canal: 'web', metodo_pago: form.metodo_pago })")).toEqual([]);
    for (const malo of [
      'track(EVENTS.TRANSACTION_CREATE_FAILED, props)',
      "track(EVENTS.TRANSACTION_CREATE_FAILED, { tipo, canal: 'web', status: { code: res.status, monto: data.monto } })",
      "track(EVENTS.TRANSACTION_CREATE_FAILED, { tipo, canal: 'web', status: data.monto })",
      "track(EVENTS.TRANSACTION_CREATE_FAILED, { tipo, canal: 'web', status: await res.text() })",
      "track(EVENTS.TRANSACTION_CREATED, { tipo, canal: 'web', metodo_pago: form.metodo_pago + ' ' + form.banco })",
      "track('transaction_amount', { tipo, canal: 'web' })",
      "posthog.capture(EVENTS.TRANSACTION_CREATED, { monto: data.monto })",
      'track(EVENTS.TRANSACTION_CREATED, { tipo, canal: "app" })',
      'track(EVENTS.TRANSACTION_CREATED, { tipo, canal: origen })',
      "track(EVENTS.TRANSACTION_CREATED, { tipo, canal: 'web', ...data })",
      "track(EVENTS.TRANSACTION_CREATED, { tipo, canal: 'web', importe: data.monto })",
    ]) expect(conLlamada(malo), malo).not.toEqual([]);
  });

  it('abrir se emite en la transición, con un ref, y no al editar', () => {
    const abrir = de('TRANSACTION_FORM_OPENED')[0];
    // La condición es la de la sentencia que contiene la llamada, desde el `if` más cercano.
    const cond = SRC.slice(SRC.lastIndexOf('if', abrir.en), abrir.en).replace(/\s+/g, ' ');
    expect(cond).toMatch(/^if \(open && !abiertoAntes\.current && !isEdit\) $/);
    expect(SRC).toMatch(/const abiertoAntes = useRef\(false\);/);
    expect([...SRC.matchAll(/abiertoAntes\.current\s*=[^=][^;]*;/g)].map((m) => m[0])).toEqual([
      'abiertoAntes.current = open;',
    ]);
  });

  it('crear sale después de comprobar res.ok y antes de salir del try; fallar, dentro de la rama de error', () => {
    const post = SRC.indexOf("method: 'POST'");
    const ramaError = SRC.indexOf('if (!res.ok)', post);
    const retorno = SRC.indexOf('return;', ramaError);
    const catchDelTry = SRC.indexOf('} catch', post);
    const [crear] = de('TRANSACTION_CREATED');
    const [falloHttp, falloRed] = de('TRANSACTION_CREATE_FAILED');
    expect(ramaError).toBeGreaterThan(post);
    expect(falloHttp.en).toBeGreaterThan(ramaError);
    expect(falloHttp.en).toBeLessThan(retorno);
    expect(crear.en).toBeGreaterThan(retorno);
    expect(crear.en).toBeLessThan(catchDelTry);
    expect(falloRed.en).toBeGreaterThan(catchDelTry);
    expect(falloRed.en).toBeLessThan(SRC.indexOf('finally', catchDelTry));
  });
});
