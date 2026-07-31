import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

// El state OAuth de Gmail ahora puede llevar `uid` (usuario_id) para resolver el
// vínculo por identidad y no por número. Es el fix que permite que un Pro web-only
// (sin whatsapp) conecte Gmail: antes el state iba solo por `num`, así que un
// número vacío dejaba al callback sin a quién asignar el token → 404.
//
// Round-trip real (sin mocks): generarUrlAutorizacion arma la URL con el state
// firmado; verificarState valida la firma HMAC y lo decodifica. Ambos usan el
// mismo secreto del entorno (aquí vacío/consistente), así que el ciclo cierra.

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..'
);
const { generarUrlAutorizacion, verificarState } = require(path.join(projectRoot, 'gmail.js'));

const stateDe = (url) => new URL(url).searchParams.get('state');

describe('state OAuth Gmail — uid (identidad) vs num (número)', () => {
  it('flujo web con usuario_id: el state lleva uid, num y origen', () => {
    const url = generarUrlAutorizacion('51999888777', 'inicial', 'web', 'uid-123');
    const obj = verificarState(stateDe(url));
    expect(obj).toBeTruthy();
    expect(obj.uid).toBe('uid-123');
    expect(obj.num).toBe('51999888777');
    expect(obj.origen).toBe('web');
    expect(obj.modo).toBe('inicial');
  });

  it('Pro web-only (sin número): el state igual lleva uid, con num vacío', () => {
    // Este es el caso que rompía: whatsapp null -> num ''. Con uid, el callback
    // resuelve por identidad de todas formas.
    const url = generarUrlAutorizacion(null, 'inicial', 'web', 'uid-abc');
    const obj = verificarState(stateDe(url));
    expect(obj.uid).toBe('uid-abc');
    expect(obj.num).toBe('');
  });

  it('flujo WhatsApp (sin usuario_id): el state NO lleva uid — resolución por num, sin cambios', () => {
    const url = generarUrlAutorizacion('51999888777', 'reemplazar');
    const obj = verificarState(stateDe(url));
    expect(obj.uid).toBeUndefined();
    expect(obj.num).toBe('51999888777');
    expect(obj.modo).toBe('reemplazar');
  });

  it('un state manipulado no valida (la firma protege el uid igual que el resto)', () => {
    const url = generarUrlAutorizacion('51999888777', 'inicial', 'web', 'uid-123');
    const state = stateDe(url);
    const [payload, sig] = state.split('.');
    // alterar el payload (cambiar el uid) sin re-firmar debe romper la verificación
    const tampered = Buffer.from(JSON.stringify({ num: '', uid: 'otro-uid', modo: 'inicial', ts: Date.now() })).toString('base64url');
    expect(verificarState(`${tampered}.${sig}`)).toBeNull();
    expect(payload).toBeTruthy();
  });
});
