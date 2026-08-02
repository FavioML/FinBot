# Runbook: a un usuario le faltan datos

Escrito después del 01-ago-2026, donde esto costó un día entero porque no había
ni rastro ni procedimiento. Ahora son minutos. Orden importa: **primero mirar,
después restaurar**.

## 1. Ver qué se borró y quién lo borró

```sql
select borrado_at, tabla, fila_id, contexto, fila
  from borrados_auditoria
 where usuario_id = '<uuid>'
 order by borrado_at desc;
```

`contexto` dice de dónde vino el borrado, y esa es la pregunta que antes no se
podía contestar:

| Qué ves en `contexto` | Qué significa |
|---|---|
| `app_name: mgmt-api`, sin `req_path` | SQL a mano: editor del dashboard o MCP de Supabase |
| `app_name: postgrest` + `req_path: /transacciones` | Entró por la API: backend, webapp o un harness |
| `client_addr: ::1` | El proceso corría en la misma máquina que la DB (backend en Railway) |

Si no hay filas, el borrado es anterior a la migración 055 (01-ago-2026) o fue en
una tabla fuera de alcance (solo se auditan `transacciones`, `deudas` y
`deuda_abonos`).

## 2. Restaurar

Todo lo borrado de un usuario en una ventana, en orden de FK:

```sql
select * from restaurar_borrados_de('<uuid>', '2026-08-01 15:00:00+00');
```

Devuelve cuántas filas entraron por tabla. Es **idempotente**: correrlo dos veces
no duplica nada, las que ya volvieron salen como `ya_estaban`. Una fila suelta:
`select restaurar_borrado(<id de borrados_auditoria>);`

La fila que vuelve es exactamente la que se borró, con su `id` y sus timestamps.
No hay ventana de pérdida como con el backup diario.

## 3. Verificar

Contar no alcanza. Hay que comparar **qué ids del origen no llegaron**, que es
justo el error que dejó a un usuario sin sus 4 deudas activas durante un día:

```sql
select count(*) filter (where t.id is null) as faltan
  from borrados_auditoria a
  left join transacciones t on t.id = a.fila_id::uuid
 where a.usuario_id = '<uuid>' and a.borrado_at >= '<desde>' and a.tabla = 'transacciones';
```

Recién con `faltan = 0` tiene sentido comparar montos o checksums.

## Si la auditoría no alcanza: el backup diario

Solo hace falta si el borrado es anterior a la 055, o si se corrompió algo que el
trigger no cubre.

- El plan **Pro** toma un backup diario automático, con 7 días de retención. No
  hay que hacer nada para que ocurra. Se ven en Database → Backups.
- La ventana de pérdida es de hasta 24h: lo que el usuario registró entre el
  snapshot y el problema no está en ningún lado. Point-in-Time Recovery elimina
  esa ventana pero es un add-on aparte que hay que activar y pagar.
- Los snapshots se toman alrededor de las 10:0x UTC (05:00 Lima).

**Siempre "Restore to new project", nunca el botón "Restore" de la lista.** El
segundo pisa el proyecto entero, lo deja inaccesible durante el proceso y borra
todo lo posterior al backup. Con el clon aparte, se lee con el MCP de Supabase
usando solo el project id y se copia lo que falte:

```sql
insert into public.<tabla>
select * from json_populate_recordset(null::public.<tabla>, '<json_agg del clon>')
on conflict do nothing;
```

En orden de FK (`deudas` antes que `deuda_abonos`). Después conviene recalcular
el score (`services/neto-score.js` → `upsertScore(uid)`), porque el cron lo
calculó sobre la cuenta incompleta. El clon cobra mientras exista: borrarlo
cuando la verificación del paso 3 dé limpio.

## Por qué el WAL y el heap no son opciones

Ya se probaron el 01-ago y no sirven, no vale la pena reintentarlas: `pageinspect`
necesita superuser y Supabase no lo da, y con `replica identity = default` un
DELETE solo deja la PK en el WAL.
