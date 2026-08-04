---
name: test-backend
description: Ejecuta los tests del backend de Neto (vitest) y reporta resultados con cobertura
allowed_tools: Bash, Read, Grep
---

# Test Backend — Neto WhatsApp Bot

Cuando el usuario quiera correr los tests del backend o verificar que todo funciona tras un cambio.

## Ejecucion

### 1. Correr tests
```bash
npm test
```
Framework: vitest. El conteo NO se escribe aca: decia 56 cuando ya eran cientos. El numero de hoy lo imprime la corrida.
Archivos de test: `tasks/tests/`

### 2. Interpretar resultados
- Reportar: tests pasados, fallidos, tiempo total
- Si hay fallos: identificar el test, leer el archivo, y diagnosticar la causa raiz
- Verificar que NO hay `console.log` en codigo de produccion (debe usar Pino logger)

### 3. Verificar cobertura critica
Los tests cubren:
- Parsers de correos bancarios (11 bancos: BCP, BBVA, Interbank, Scotiabank, Yape, Plin, Falabella, Ripley, BanBif, Mibanco, CMAC)
- Validacion de montos (NaN, Infinity, negativos, >999999.99)
- Dedup hash MD5
- Formatters y utilidades
- Clasificacion IA (intenciones NLP)

### 4. Post-test
- Si todos pasan: confirmar con mensaje claro
- Si hay fallos: proponer fix inmediato (correccion autonoma de bugs)
- Nunca marcar como "completo" si hay tests rojos
