import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bancoDeDominio, clausulasAuthResults, firmasDkimValidas, tieneDkimAlineadoDeBanco } = require('../../lib/auth-results');

/**
 * El parser de Authentication-Results es un GUARD: decide qué texto de un tercero llega al modelo
 * que escribe gastos. Cada rama del tokenizer tiene acá un caso que la necesita, así que borrar
 * una (comillas, anidamiento, escape, comentario) pone este archivo rojo. Los casos usan
 * `firmasDkimValidas`, que NO exige alineación: la alineación tapa los errores del parser y acá
 * se quiere ver el parser solo.
 */

const AR = (v) => [{ name: 'Authentication-Results', value: v }];
const firmas = (v) => firmasDkimValidas(AR(v));

describe('clausulasAuthResults', () => {
  it('borra un comentario con un `;` adentro', () => {
    expect(firmas('mx.google.com; dkim=none; spf=neutral (google.com: x; dkim=pass header.d=bcp.com.pe; y) smtp.mailfrom=a.com')).toEqual([]);
  });

  it('respeta los comentarios anidados', () => {
    expect(firmas('mx.google.com; spf=pass (a (b) ; dkim=pass header.d=bcp.com.pe ; c) smtp.mailfrom=a.com')).toEqual([]);
  });

  it('un `\\)` escapado no cierra el comentario', () => {
    expect(firmas('mx.google.com; spf=pass (x \\) ; dkim=pass header.d=bcp.com.pe ; y) smtp.mailfrom=a.com')).toEqual([]);
  });

  // Las comillas se prueban sobre el tokenizer directo: `firmasDkimValidas` rechaza entero un
  // header con comillas, así que a través de ella estas ramas no se verían.
  it('un `;` entre comillas no parte la cláusula', () => {
    expect(clausulasAuthResults('mx.google.com; spf=pass smtp.mailfrom="a;dkim=pass header.d=x;b"@x.com'))
      .toEqual(['mx.google.com', 'spf=pass smtp.mailfrom="a;dkim=pass header.d=x;b"@x.com']);
  });

  it('un `\\"` escapado no cierra las comillas', () => {
    expect(clausulasAuthResults('mx.google.com; spf=pass smtp.mailfrom="a\\";dkim=pass header.d=x;"@e.com')).toHaveLength(2);
  });

  it('un header con comillas no aporta firmas, ni siquiera las de fuera de las comillas', () => {
    // La inyección desde el sobre SMTP de la revisión del 30-oct: el `)` cierra el comentario
    // del SPF y deja suelta una cláusula falsa sin comillas propias.
    expect(firmas('mx.google.com; dkim=pass header.i=@evil.com header.s=k; spf=pass (google.com: domain of "a)b;dkim=pass header.d=bcp.com.pe;("@evil.com designates 1.2.3.4) smtp.mailfrom="a)b;dkim=pass header.d=bcp.com.pe;("@evil.com')).toEqual([]);
    expect(firmas('mx.google.com; dkim=pass header.i="a header.d=bcp.com.pe b"@atacante.com header.s=s1')).toEqual([]);
  });

  it('parte el header real en sus cláusulas', () => {
    expect(clausulasAuthResults('mx.google.com;\r\n  dkim=pass header.i=@yape.pe header.s=s1;\r\n  spf=pass (google.com: x) smtp.mailfrom=yape.pe'))
      .toEqual(['mx.google.com', 'dkim=pass header.i=@yape.pe header.s=s1', 'spf=pass   smtp.mailfrom=yape.pe']);
  });
});

describe('firmasDkimValidas', () => {
  it('lee header.d y el dominio de header.i, en minúsculas', () => {
    expect(firmas('MX.GOOGLE.COM; DKIM=PASS HEADER.I=@BCP.COM.PE header.s=s1; dkim=pass header.d=yape.pe')).toEqual(['bcp.com.pe', 'yape.pe']);
  });

  it('ignora las firmas que no son pass', () => {
    expect(firmas('mx.google.com; dkim=fail header.d=bcp.com.pe; dkim=neutral header.d=bcp.com.pe; dkim=temperror header.d=bcp.com.pe')).toEqual([]);
  });

  it('solo cree el PRIMER header, y solo si es de mx.google.com', () => {
    expect(firmasDkimValidas([
      { name: 'Authentication-Results', value: 'mx.google.com; dkim=none' },
      { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=bcp.com.pe' },
    ])).toEqual([]);
    expect(firmas('mx.google.com.atacante.com; dkim=pass header.d=bcp.com.pe')).toEqual([]);
    expect(firmasDkimValidas([{ name: 'ARC-Authentication-Results', value: 'mx.google.com; dkim=pass header.d=bcp.com.pe' }])).toEqual([]);
  });
});

describe('bancoDeDominio', () => {
  it('reconoce dominios y subdominios del banco', () => {
    expect(bancoDeDominio('bcp.com.pe')).toBe('bcp');
    expect(bancoDeDominio('email.bcp.com.pe')).toBe('bcp');
    expect(bancoDeDominio('yape.com.pe.')).toBe('bcp');
    expect(bancoDeDominio('avisos.interbank.pe')).toBe('interbank');
  });

  it('no confunde dominios parecidos ni mal formados', () => {
    expect(bancoDeDominio('scotiabank.com.pe')).toBe('scotiabank');
    // Sin DMARC, con p=none, o con sp=none para sus subdominios: ahí la alineación no protege.
    for (const d of ['bcp.com.pe.atacante.com', 'falsobcp.com.pe', 'yape.pe-seguro.com', 'yape.pe>)', 'scotiabank.pe', 'plin.pe',
      'bancoripley.com.pe', 'alertas.scotiabank.com.pe', '', null]) {
      expect(bancoDeDominio(d), String(d)).toBeNull();
    }
  });
});

describe('tieneDkimAlineadoDeBanco', () => {
  const firmaBcp = AR('mx.google.com; dkim=pass header.d=bcp.com.pe header.s=s1');
  it('exige que el From sea del mismo banco que firmó', () => {
    expect(tieneDkimAlineadoDeBanco(firmaBcp, 'notificacionesbcp.com.pe')).toBe(true);
    expect(tieneDkimAlineadoDeBanco(firmaBcp, 'interbank.pe')).toBe(false);
    expect(tieneDkimAlineadoDeBanco(firmaBcp, 'evil.com')).toBe(false);
  });
});
