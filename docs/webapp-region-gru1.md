# Las funciones de la webapp corren en `gru1` (São Paulo)

Relato de la medición que decidió `"regions": ["gru1"]` en `webapp/vercel.json`. La regla vigente
vive en `webapp/CLAUDE.md` (sección Deploy); este archivo guarda el porqué con sus números. Salió de
ahí el 12-oct-2026 para que el CLAUDE.md volviera a estar bajo su tope de tamaño.

`"regions": ["gru1"]` en `webapp/vercel.json`. La base de Supabase esta en `sa-east-1`
(São Paulo) y los usuarios estan en Lima: `iad1` (Washington) era el peor de los tres
vertices. Medido el 30-ago-2026 con un A/B de preview contra preview — **una rama de
control en `iad1` desde el mismo commit base**, para no confundir "region" con "preview
vs prod" — interleaved, dos tandas:

| `/api/dashboard`, mediana desde Lima | n=6 | n=12 |
|---|---|---|
| preview `iad1` (control) | 1240 ms (disp. 406) | 1097 ms (disp. 829) |
| preview `gru1` | **349 ms** (disp. 3543) | **275 ms** (disp. 233) |
| prod `iad1`, del mismo lote | 1348 ms | 949 ms |

El control es la fila que hace valida la comparacion: sale igual que prod, o sea que la
diferencia no la trae el entorno de preview. Y `/api/version` —cero consultas— pasa de
~230 ms a ~113 ms, asi que la mitad del ahorro no es la base: es el viaje del navegador
a la funcion, que desde Lima a `gru1` es local.

**Lo que se paga, medido en la misma sesion** con una ruta de diagnostico temporal en las
dos regiones (5 corridas, mediana):

| destino desde la funcion | `iad1` | `gru1` |
|---|---|---|
| Supabase (consulta real, 200) | 225 ms | **144 ms** |
| `api.neto.pe` (Railway) | 109 ms | **232 ms** |
| `api.openai.com` | 85 ms | **153 ms** |

Railway y OpenAI estan en EE.UU. y se alejaron ~+120 ms y ~+70 ms por llamada. Ninguno
de los dos esta en el arranque del dashboard: los pagan `/api/advice`, `/api/admin/*`,
`/api/pro/*`, `/api/cuenta` y `lib/trial-backend.ts`, que son acciones puntuales. Se
cambio latencia de una accion ocasional por latencia de **cada carga de cada usuario**.
Si algun dia Railway se mueve a Sudamerica, este numero mejora solo; **no** al reves.

Dos cosas que costaron descubrir al medirlo:

- **`preferredRegion` por segmento de ruta NO sirve para lambdas de Node.** El builder de
  Next excluye `regions` del manifiesto de config por ruta a proposito: para funciones
  Node la region solo se toma de `vercel.json`.
- **La comprobacion es el header, no el archivo.** `x-vercel-id` viene
  `<borde>::<region>::<id>`: hoy tiene que decir `gru1::gru1`. Un `gru1::iad1` significa
  que el borde recibe cerca pero la funcion sigue lejos.
