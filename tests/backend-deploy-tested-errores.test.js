import { describe, it, expect } from 'vitest';

import { es404 } from '../qa-e2e/backend-deploy-tested.mjs';

/**
 * `backend-deploy-tested` clasifica el fallo de `gh` en dos cajones muy distintos:
 * un 404 del workflow es **GUARD CIEGO** (exit 1: alguien renombró `ci.yml` y el gate se
 * quedó sin testigo), y cualquier otra cosa es infra (exit 2, sin veredicto).
 *
 * La clasificación se equivocó en las dos direcciones, una después de la otra:
 *
 *   1. Miraba solo `e.message`, donde `gh` NO escribe el motivo → la rama de guard-ciego
 *      no se alcanzaba nunca. Lo encontró una prueba por mutación.
 *   2. El arreglo la ensanchó a `stderr + message`, y `message` es "Command failed: gh api
 *      .../runs?head_sha=<40 hex>..." → un sha que contenga "404" convierte cualquier caída
 *      de red en un falso GUARD CIEGO.
 *
 * Los dos casos están abajo. El segundo es el fixture malicioso: pasa si se mira stderr, y
 * falla si alguien vuelve a meter `message` en la comparación.
 */

/** La forma real de la excepción de `execFileSync('gh', ...)`, verificada el 07-ago-2026. */
const errorGh = ({ stderr, message }) => ({ stderr, message });

const SHA_CON_404 = 'b3404f1e9a7c2d5084fbb1c6e0a93d27f5188cae';

describe('es404: qué fallo de gh es un guard ciego y cuál es infra', () => {
  it('reconoce el 404 real, que gh escribe en stderr', () => {
    expect(es404(errorGh({
      stderr: 'gh: Not Found (HTTP 404)\n',
      message: 'Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=89206ac\ngh: Not Found (HTTP 404)\n',
    }))).toBe(true);
  });

  it('NO llama guard ciego a una caída de red solo porque el sha desplegado contiene "404"', () => {
    const v = es404(errorGh({
      stderr: 'error connecting to api.github.com\n',
      message: `Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=${SHA_CON_404}&per_page=20\n`,
    }));
    expect(
      v,
      'clasificar por `message` mete la URL —y el sha— en la comparación: esto es infra ' +
        '(exit 2), no un ci.yml renombrado (exit 1)',
    ).toBe(false);
  });

  it('tampoco lo llama guard ciego cuando gh falla por auth y el sha tiene "404"', () => {
    expect(es404(errorGh({
      stderr: 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n',
      message: `Command failed: gh api repos/FavioML/FinBot/actions/workflows/ci.yml/runs?head_sha=${SHA_CON_404}\n`,
    }))).toBe(false);
  });

  it('no explota si la excepción no trae stderr', () => {
    expect(es404({})).toBe(false);
    expect(es404(null)).toBe(false);
    expect(es404(errorGh({ stderr: undefined, message: 'Command failed: gh api ... 404' }))).toBe(false);
  });
});
