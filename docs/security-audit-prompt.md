# Prompt de Auditoría de Seguridad — Neto

Usar este prompt periódicamente para re-auditar la seguridad del proyecto.
Última ejecución: 26 Mar 2026 (commit ba83cd0).

---

> Actúa como un CTO senior de seguridad. Realiza una auditoría completa de seguridad del proyecto Neto, un asistente financiero por WhatsApp con webapp, considerando su stack específico: Node.js + Express (backend API en Railway), Next.js (webapp en Vercel), Supabase (auth con Google OAuth + base de datos con RLS), Meta Cloud API (WhatsApp), y OpenAI API.
>
> Revisa estas 7 áreas y reporta hallazgos + fixes concretos:
>
> **1. Autenticación y sesiones**
> - Verificar que Supabase Auth está correctamente configurado (tokens JWT, refresh tokens, expiración de sesiones)
> - Asegurar que las API routes de Next.js validan el JWT en cada request (no solo cookies del cliente)
> - Verificar que no hay bypass de autenticación en ningún endpoint
> - Confirmar que el middleware protege todas las rutas /dashboard/*
>
> **2. Autorización y acceso a datos (IDOR)**
> - Revisar TODAS las API routes (/api/transactions, /api/budgets, /api/user, /api/advice, etc.)
> - Verificar que cada query a Supabase filtra por el usuario autenticado
> - Confirmar que las RLS policies en Supabase son correctas y no tienen bypass
> - Asegurar que un usuario no puede leer, modificar ni eliminar datos de otro usuario
>
> **3. Protección de secretos**
> - Escanear todo el código por API keys, tokens o credenciales hardcodeadas
> - Verificar que NEXT_PUBLIC_* solo contiene claves públicas (anon key, GA4 ID) y nunca service keys
> - Confirmar que .gitignore excluye .env y archivos sensibles
> - Revisar que el backend no expone secretos en respuestas de error o logs
>
> **4. Rate limiting y protección contra abuso**
> - Evaluar el rate limiting actual del backend (300 req/min global, 10/min admin)
> - Verificar rate limiting en las API routes de la webapp (Next.js)
> - Revisar protección contra abuso en el endpoint de IA (/api/advice que llama a GPT-4o-mini)
> - Evaluar protección del webhook de WhatsApp contra replay attacks
>
> **5. Deployment seguro**
> - Verificar headers de seguridad (CORS, CSP, X-Frame-Options, HSTS) en ambos: Railway y Vercel
> - Confirmar que la base de datos Supabase no es accesible directamente desde internet sin autenticación
> - Revisar la configuración de CORS del backend Express
> - Verificar que no hay endpoints de debug/test expuestos en producción
>
> **6. Logging y monitoreo**
> - Evaluar qué se logea en intentos de autenticación fallidos
> - Verificar que el sistema de notificaciones admin (WhatsApp) cubre eventos de seguridad
> - Confirmar que los logs redactan información sensible (Pino con redacción de secrets)
> - Identificar patrones sospechosos que deberían generar alertas
>
> **7. Validación y sanitización de inputs**
> - Identificar TODOS los puntos de entrada de datos del usuario: mensajes de WhatsApp, formularios de la webapp, uploads (Excel/CSV, imágenes Yape/Plin), query parameters en API routes, y el campo de búsqueda global (Ctrl+K)
> - Verificar sanitización contra SQL injection en queries a Supabase
> - Revisar protección contra XSS en la webapp
> - Evaluar validación de archivos subidos: tipos MIME permitidos, tamaño máximo
> - Verificar que los montos, fechas y categorías se validan estrictamente en el backend
> - Revisar que los mensajes de WhatsApp procesados por el NLP no pueden inyectar comandos o manipular el prompt de OpenAI (prompt injection)
>
> Para cada hallazgo, clasifícalo como: **CRÍTICO** (fix inmediato), **ALTO** (fix esta semana), **MEDIO** (fix este mes), o **BAJO** (mejora futura). Incluye el código exacto del fix cuando sea posible.
