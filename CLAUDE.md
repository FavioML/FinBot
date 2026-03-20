# CLAUDE.md — NETO
## Contexto del Proyecto

NETO es un asistente financiero personal por WhatsApp para el mercado peruano.
- Stack: Node.js + Express + Supabase + OpenAI GPT-4o-mini + Meta Cloud API + Railway
- Repo: github.com/FavioML/FinBot
- Archivo principal: C:\finbot\index.js (1423 líneas)
- Producción: neto.pe (Railway)
- Supabase project: zvorjqlubmfrjtkbhqcx
- Número WhatsApp producción: +51 933 014 505
- Admin WhatsApp: +51970398192

## Convenciones críticas
- Archivos grandes (>10KB): editar con Filesystem:edit_file, nunca reescribir completo
- Encoding: siempre UTF-8 sin BOM al guardar index.js
- Git push: siempre desde terminal del usuario, nunca via API de GitHub (rompe por tamaño)
- Tests: crear en tasks/tests/ con emails bancarios reales anonimizados
- Variables de entorno: gestionar en Railway via MCP, nunca hardcodear fallbacks inseguros

## Orquestación del Flujo de Trabajo

### 1. Modo Planificación por Defecto
- Entrar en modo planificación para CUALQUIER tarea no trivial (3+ pasos o decisiones arquitectónicas)
- Si algo sale mal, DETENER y replanificar de inmediato
- Usar modo planificación también para pasos de verificación, no solo para construir
- Escribir especificaciones detalladas antes de empezar para reducir ambigüedad

### 2. Estrategia de Subagentes
- Usar subagentes liberalmente para mantener limpia la ventana de contexto principal
- Delegar investigación, exploración y análisis paralelo a subagentes
- Para problemas complejos, aplicar más cómputo a través de subagentes
- Una tarea por subagente para ejecución enfocada

### 3. Bucle de Automejora
- Después de CUALQUIER corrección del usuario: actualizar tasks/lessons.md con el patrón
- Escribir reglas que prevengan el mismo error en el futuro
- Iterar sin piedad sobre estas lecciones hasta reducir la tasa de errores
- Revisar las lecciones al inicio de cada sesión del proyecto

### 4. Verificación Antes de Finalizar
- Nunca marcar una tarea como completa sin demostrar que funciona
- Comparar el comportamiento entre main y los cambios cuando sea relevante
- Preguntarse: "¿Aprobaría esto un ingeniero senior?"
- Ejecutar pruebas, revisar logs, demostrar que es correcto

### 5. Exigir Elegancia (con Balance)
- Para cambios no triviales: pausar y preguntar "¿hay una forma más elegante?"
- Si una solución se siente forzada: "Sabiendo todo lo que sé, implementar la solución elegante"
- Omitir esto para correcciones simples y obvias — no sobreingeniería
- Cuestionar el propio trabajo antes de presentarlo

### 6. Corrección Autónoma de Bugs
- Cuando se reporte un bug: simplemente arreglarlo. Sin pedir que te lleven de la mano
- Analizar logs, errores y pruebas fallidas — y resolverlos
- Cero cambios de contexto requeridos del usuario
- Corregir pruebas CI fallidas sin que se lo indiquen

---

## Gestión de Tareas

1. **Planificar Primero**: Escribir el plan en tasks/todo.md con ítems marcables
2. **Verificar el Plan**: Confirmar antes de comenzar la implementación
3. **Seguir el Progreso**: Marcar ítems como completados a medida que avanza
4. **Explicar Cambios**: Resumen de alto nivel en cada paso
5. **Documentar Resultados**: Agregar sección de revisión en tasks/todo.md
6. **Capturar Lecciones**: Actualizar tasks/lessons.md después de correcciones

---

## Principios Fundamentales

- **Simplicidad Primero**: Hacer cada cambio lo más simple posible. Impacto mínimo en el código.
- **Sin Pereza**: Encontrar causas raíz. Sin soluciones temporales. Estándares de desarrollador senior.
- **Impacto Mínimo**: Tocar solo lo necesario. Sin efectos secundarios ni bugs nuevos.
