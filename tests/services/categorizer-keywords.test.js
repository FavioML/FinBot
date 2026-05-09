import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { categorizarPorKeywords } = require('../../services/categorizer-keywords');

// Mensaje str-003: 400+ chars de prosa con monto en palabras y mecánico.
const PROSA_AUTO = 'uy hermano hoy fue un día durísimo, salí temprano de la casa con el coche pero a la altura del óvalo Gutiérrez se quedó el motor frío y tuve que llamar al mecánico de confianza que me cobró setenta y cinco soles por venir hasta acá y revisar el alternador, al final solo era un cable suelto pero ya saben cómo es esto, así que registra ese gasto por favor en la categoría que mejor cuadre';

describe('categorizarPorKeywords', () => {
  it('str-003: prosa larga con "mecánico" y "alternador" → Transporte', () => {
    expect(categorizarPorKeywords(PROSA_AUTO)).toBe('Transporte');
  });

  it('control: msg corto sin marcadores fuertes → null', () => {
    // El handler restringe a msg.length > 150, pero la función misma debe
    // matchear keyword incluso en msgs cortos (la longitud la enforza el caller).
    // Aquí validamos que un msg sin keywords retorna null aunque sea largo.
    expect(categorizarPorKeywords('gasté 50 en taxi')).toBe(null);
  });

  it('prosa larga sin keyword inequívoco → null (el handler lo deja en sin_categoria)', () => {
    const prosaSinKw = 'uy hermano hoy fue un día durísimo, terminé exhausto después de una jornada larga sin parar y al final ni siquiera pude descansar, total que gasté setenta y cinco soles en algo que no recuerdo bien y prefiero registrarlo igual para no perder el track de mis gastos del mes, así que regístralo nomás';
    expect(categorizarPorKeywords(prosaSinKw)).toBe(null);
  });

  it('prosa larga con "farmacia" + síntomas → Salud', () => {
    const prosaSalud = 'había estado con dolor de cabeza todo el día y como ya no aguantaba más fui corriendo a la farmacia de la esquina para comprar unas pastillas que me recomendó el doctor la semana pasada, terminé pagando 35 soles por todo el medicamento incluido un jarabe para la tos que también me hacía falta porque sentía que algo me venía';
    expect(categorizarPorKeywords(prosaSalud)).toBe('Salud');
  });

  it('null/empty input → null', () => {
    expect(categorizarPorKeywords(null)).toBe(null);
    expect(categorizarPorKeywords('')).toBe(null);
    expect(categorizarPorKeywords(undefined)).toBe(null);
  });
});
