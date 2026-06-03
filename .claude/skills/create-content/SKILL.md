---
name: create-content
description: Crea contenido para redes sociales de Neto (carruseles, posts, videos, stories, imágenes) usando las herramientas internas de Claude. Usa esta skill cuando el usuario pida crear un post, carrusel, story, video, imagen o cualquier pieza de contenido para Instagram, TikTok, Facebook o redes sociales de Neto. También cuando diga "post 1", "crea el carrusel", "hazme una story", "genera contenido", o haga referencia al plan de contenido orgánico.
argument-hint: 'post 1, carrusel gastos hormiga, story poll, video demo, imagen para instagram'
user-invocable: true
---

# Create Content — Neto Social Media

Crea piezas de contenido para las redes sociales de Neto usando las herramientas de creación de contenido disponibles en Claude. El objetivo es producir contenido listo para publicar: imágenes, carruseles, videos y stories con el branding de Neto.

## Plan de Contenido

El plan maestro con los 10 primeros posts, captions, hashtags y calendario está en:
**`C:\Neto.pe\docs\PLAN-CONTENIDO-ORGANICO.md`**

Cuando el usuario pida "post N" o "carrusel de X", leer ese archivo primero para obtener el contenido exacto (slides, scripts, captions, hashtags).

---

## Brand Guidelines de Neto

Estas reglas aplican a TODO el contenido generado. Internalizarlas es clave para que cada pieza se sienta coherente con la marca.

### Paleta de colores
| Uso | Color | Hex |
|-----|-------|-----|
| Fondo principal | Dark | #1D1D1A |
| Fondo alternativo | Dark blue-gray | #111827 |
| Acento primario | Verde Neto | #1D9E75 |
| Acento secundario | Ámbar (números, alertas) | #EF9F27 |
| Texto principal | Blanco | #FFFFFF |
| Texto secundario | Gris | #9CA3AF |

### Tono de voz
- **Personalidad:** "El amigo listo" — casual, cercano, peruano
- **Idioma:** Español peruano natural. Usar "plata", "pe", "chamba" con moderación
- **Enfoque:** Automatización es el diferencial ("tus gastos se registran solos", "sin hacer nada")

### Reglas de copy (inquebrantables)
- ✅ SIEMPRE: tildes (á, é, í, ó, ú), ñ, signos ¿¡ — ortografía perfecta del español
- ✅ SIEMPRE: "automático", "sin hacer nada", "sin contraseñas bancarias"
- ✅ SIEMPRE: "Regístrate en 2 minutos", "Empieza ahora"
- ❌ NUNCA: "conecta tu banco" (genera miedo)
- ❌ NUNCA: "11 bancos" o listar cantidades grandes de bancos
- ❌ NUNCA: lenguaje financiero intimidante ("portafolio", "activos")

### Tipografía (para prompts de generación)
- Títulos: Bold, grande
- Cuerpo: Regular, legible
- Números destacados: Extra bold, color ámbar o verde

---

## Herramientas Disponibles y Cuándo Usar Cada Una

La elección de herramienta depende del tipo de contenido. Aquí está la lógica de decisión:

### 1. Canva MCP — Diseños profesionales con plantillas
**Herramienta:** `mcp__a3c8fe90-825e-4943-a951-f9457219798d__generate-design`

**Ideal para:** Contenido que se beneficia de plantillas profesionales y layout pulido.

| Caso de uso | design_type |
|-------------|-------------|
| Post Instagram (1 imagen) | `instagram_post` |
| Post Facebook | `facebook_post` |
| Story Instagram/TikTok | `your_story` |
| Carrusel (multi-página) | `instagram_post` (generar 1 por slide) |
| Infografía | `infographic` |
| Cover YouTube | `youtube_banner` |
| Thumbnail YouTube | `youtube_thumbnail` |

**Flujo Canva completo:**
1. Generar con `generate-design` → devuelve candidatos con preview
2. Pedir al usuario que elija candidato (o elegir el mejor)
3. Guardar con `create-design-from-candidate` → devuelve `design_id`
4. Exportar con `export-design` (format: png, jpg, o pdf) → devuelve URL de descarga
5. Compartir la URL de descarga al usuario

**Query tips para Canva:**
- Incluir SIEMPRE: colores exactos, texto a mostrar, estilo dark/minimalista
- Ejemplo: "Dark minimal Instagram post with background #1D1D1A, green accent #1D9E75. Title in white bold: '5 GASTOS HORMIGA que te roban S/300 al mes'. Small logo text '@neto_peru' bottom right. Clean modern style, no stock photos."

### 2. nanobanana — Imágenes IA custom
**Herramienta:** `mcp__nanobanana__generate_image`

**Ideal para:** Imágenes únicas, artísticas, fondos custom, hero images donde no hay plantilla que sirva.

| Caso de uso | aspect_ratio |
|-------------|-------------|
| Post cuadrado | 1:1 |
| Story / Reel | 9:16 |
| Cover Facebook/YouTube | 16:9 |
| Post vertical Pinterest | 2:3 |

**Tips para prompts:**
- Ser muy descriptivo: sujeto, composición, acción, ubicación, estilo
- Incluir texto a renderizar (nanobanana puede generar texto en imagen)
- Especificar: "Dark background #1D1D1A, green accent #1D9E75"
- Para calidad máxima: usar `model_tier: "pro"` y `resolution: "4k"`

### 3. canvas-design skill — Arte visual con filosofía de diseño
**Herramienta:** Invocar skill `canvas-design`

**Ideal para:** Piezas gráficas especiales, arte conceptual, diseños únicos que necesitan pensamiento de diseño más profundo. Genera PNG y PDF.

### 4. stitch — Mockups UI
**Herramienta:** `mcp__stitch__generate_screen_from_text`

**Ideal para:** Mockups del dashboard de Neto (app.neto.pe), capturas conceptuales del producto.

**Requiere un proyecto stitch creado primero** con `mcp__stitch__create_project`.
Usar `deviceType: "MOBILE"` para mockups de WhatsApp, `"DESKTOP"` para dashboard.

### 5. create-video skill — Videos animados Remotion
**Herramienta:** Invocar skill `create-video`

**Ideal para:** Videos promocionales animados con motion graphics, texto animado, transiciones.

- **Editor Pro Max:** C:\editor-pro-max
- **Brand preset:** src/presets/neto.ts
- **Output:** C:\Neto.pe\videos\
- Tipos: TikTok/Reel (1080×1920), YouTube (1920×1080), Story (1080×1920), Post (1080×1080)

### 6. video-explainer — Videos explicativos
**Herramienta:** Invocar skill `ve:explainer`

**Ideal para:** Videos de demo/tutorial más largos, explicaciones de producto con narración.

### 7. Screen recordings del usuario
El usuario puede proporcionar grabaciones de pantalla de su celular (del chat de WhatsApp con Neto o del dashboard). Estos sirven como:
- Referencia visual para generar contenido similar
- Input para nanobanana (editar/mejorar la captura)
- Inspiración para composiciones de Remotion

---

## Flujo de Trabajo

### Cuando el usuario pide contenido específico del plan:
1. Leer `C:\Neto.pe\docs\PLAN-CONTENIDO-ORGANICO.md`
2. Identificar el post solicitado (por número o tema)
3. Determinar tipo de contenido (carrusel, reel, imagen, etc.)
4. Seleccionar herramienta según la tabla de decisión
5. Generar el contenido con branding Neto
6. Exportar/guardar
7. Proporcionar caption y hashtags del plan

### Cuando el usuario pide contenido libre:
1. Confirmar: tipo de contenido, red social, tema
2. Escribir el copy siguiendo las reglas de brand voice
3. Seleccionar herramienta
4. Generar
5. Exportar

### Para carruseles multi-slide:
Los carruseles son el formato más complejo. Dos estrategias:

**Estrategia A — Canva individual por slide:**
Generar cada slide como un `instagram_post` separado en Canva con query muy detallada que incluya el texto exacto de cada slide. Esto da más control por slide.

**Estrategia B — nanobanana por slide:**
Generar cada slide como imagen 1:1 con nanobanana, incluyendo el texto exacto en el prompt. Mejor para slides con mucho texto donde el layout importa menos.

Preferir Estrategia A para slides con gráficos/iconos, Estrategia B para slides de texto puro.

---

## Revisión de Calidad (OBLIGATORIA)

Después de generar CUALQUIER pieza de contenido visual (imagen, slide, carrusel), se debe realizar una revisión exhaustiva antes de presentar el resultado al usuario. Esta revisión existe porque los errores de layout son comunes en generación programática y el usuario no debería tener que cazarlos.

### Checklist de revisión por cada imagen generada:

**1. Texto legible y sin superposiciones**
- Ningún texto se sobrepone a otro texto
- Ningún emoji tapa letras
- Los textos no se salen del canvas ni se cortan
- El texto dentro de cards/recuadros cabe completamente dentro de ellos

**2. Alineación y espaciado**
- Los elementos están centrados cuando deben estarlo
- No hay elementos "flotando" descuadrados fuera de sus contenedores
- El spacing entre secciones es consistente
- Las cards no se solapan entre sí

**3. Ortografía español**
- Todas las tildes presentes (á, é, í, ó, ú)
- La ñ correcta donde corresponde
- Signos de apertura ¿ y ¡ presentes

**4. Brand compliance**
- Logo de Neto visible
- Colores dentro de la paleta (verde #1D9E75, ámbar #EF9F27, fondo #1D1D1A)
- Slide numbers presentes en carruseles

**5. Contenido correcto**
- Los montos en soles coinciden con el plan de contenido
- Los cálculos matemáticos son correctos (ej: S/7 × 20 = S/140)

### Cómo realizar la revisión:

Después de generar las imágenes, abrirlas con la herramienta Read para verificar visualmente cada punto del checklist. Si se detecta un problema:
1. Identificar la causa en el código/prompt
2. Corregir
3. Regenerar
4. Volver a verificar

Solo presentar imágenes al usuario una vez que pasen la revisión completa. Si hay dudas sobre un layout, verificarlo visualmente antes de entregar.

### Errores frecuentes a vigilar:
- `center_text()` + `draw.text()` en el mismo elemento = texto duplicado/superpuesto
- Emojis renderizados encima de texto adyacente (son más anchos de lo esperado)
- Posiciones Y calculadas dinámicamente que empujan contenido fuera del canvas 1080px
- Cards que se extienden más allá de los márgenes inferiores

---

## Ejemplos de Uso

**"Crea el post 1"** → Lee el plan → Post 1 es carrusel "5 gastos hormiga" → 7 slides → Genera cada slide en Canva como instagram_post → Exporta → Da el caption con hashtags

**"Hazme una story con encuesta"** → Canva your_story con diseño dark y el texto de la encuesta del plan

**"Video demo de Neto"** → Invoca skill create-video para un Reel 30s con screen recording

**"Imagen motivacional sobre ahorro"** → nanobanana 1:1 con prompt artístico dark + verde + texto

**"Mockup del dashboard"** → stitch con deviceType DESKTOP y prompt del dashboard de Neto
