import { describe, expect, it } from 'vitest'
import { esSondaDeRendimiento } from './sonda'

// UAs reales, copiados de PostHog (11-sep-2026), no inventados.
const UA_PSI_MOVIL =
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36'
const UA_ANDROID_REAL = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
// El navegador de Instagram SÍ manda el modelo del equipo. Una persona con ese Motorola que
// entra desde la bio no puede caer como sonda.
const UA_INSTAGRAM_MOTO =
  'Mozilla/5.0 (Linux; Android 12; moto g power (2022) Build/S3RQS32.20-42-10-6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0.0.0 Mobile Safari/537.36 Instagram 390.0.0.0'

describe('esSondaDeRendimiento', () => {
  it('reconoce los cache-busters de las mediciones', () => {
    expect(esSondaDeRendimiento('?cwv=mobile-1', UA_IPHONE)).toBe(true)
    expect(esSondaDeRendimiento('?det=2', UA_IPHONE)).toBe(true)
    expect(esSondaDeRendimiento('?utm_source=ig&cwv=3', UA_IPHONE)).toBe(true)
  })

  it('reconoce la corrida de PageSpeed sin query (el canary diario)', () => {
    expect(esSondaDeRendimiento('', UA_PSI_MOVIL)).toBe(true)
  })

  it('no confunde un parámetro que solo CONTIENE cwv/det ni un valor', () => {
    expect(esSondaDeRendimiento('?budget=1', UA_IPHONE)).toBe(false)
    expect(esSondaDeRendimiento('?xdet=1', UA_IPHONE)).toBe(false)
    expect(esSondaDeRendimiento('?utm_source=det', UA_IPHONE)).toBe(false)
    expect(esSondaDeRendimiento('?ref=ABCD', UA_ANDROID_REAL)).toBe(false)
  })

  it('deja pasar a las personas, incluida la que tiene ese Motorola en Instagram', () => {
    expect(esSondaDeRendimiento('', UA_IPHONE)).toBe(false)
    expect(esSondaDeRendimiento('', UA_ANDROID_REAL)).toBe(false)
    expect(esSondaDeRendimiento('?utm_source=ig&utm_medium=bio', UA_INSTAGRAM_MOTO)).toBe(false)
  })
})
