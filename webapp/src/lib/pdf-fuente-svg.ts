/**
 * La fuente de la app para los gráficos del PDF de Reportes.
 *
 * html2canvas pinta cada `<svg>` como una imagen aparte (`data:image/svg+xml`), y un SVG
 * cargado como imagen no ve ni el CSS ni las fuentes web de la página: los ejes de Recharts
 * salían en serif. `document.fonts.ready` no sirve, porque la fuente ya está cargada; lo que
 * falta es que la imagen la tenga adentro. Por eso a cada SVG del clon se le pone la familia
 * de la página y una `@font-face` con el archivo embebido.
 *
 * Si no se puede leer el archivo (CSS de otro origen, fetch caído), el SVG igual recibe la
 * familia con `sans-serif` al final: sale en la sans del sistema y no en serif.
 */
export async function fuenteSvgParaPdf(): Promise<(doc: Document) => void> {
  const familia = `${getComputedStyle(document.body).fontFamily}, sans-serif`;
  let fontFace = '';
  try {
    const regla = reglaLatinBasico();
    const url = regla?.style.getPropertyValue('src').match(/url\("?([^")]+)"?\)/)?.[1];
    if (regla && url) {
      // El `src` es relativo a la hoja de estilos, no a la página.
      const absoluta = new URL(url, regla.parentStyleSheet?.href ?? location.href);
      const archivo = await fetch(absoluta).then((r) => (r.ok ? r.blob() : Promise.reject(r.status)));
      const datos = await new Promise<string>((ok, mal) => {
        const lector = new FileReader();
        lector.onload = () => ok(String(lector.result));
        lector.onerror = mal;
        lector.readAsDataURL(archivo);
      });
      // Un solo archivo para todos los pesos: next/font baja la versión variable.
      fontFace = `@font-face{font-family:${regla.style.getPropertyValue('font-family')};src:url(${datos}) format("woff2");font-weight:300 700}`;
    }
  } catch {
    // Queda la familia sola: ver el docblock.
  }
  return (doc) => {
    // Sólo los que tienen texto (los gráficos): a un ícono la fuente embebida sólo le suma peso.
    for (const svg of Array.from(doc.querySelectorAll('svg:has(text)'))) {
      svg.setAttribute('font-family', familia);
      if (!fontFace) continue;
      const estilo = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
      estilo.textContent = fontFace;
      svg.prepend(estilo);
    }
  };
}

/** La `@font-face` de la familia de la página que cubre el latín básico (U+0-FF). */
function reglaLatinBasico(): CSSFontFaceRule | null {
  const familia = getComputedStyle(document.body).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  for (const hoja of Array.from(document.styleSheets)) {
    let reglas: CSSRuleList;
    try {
      reglas = hoja.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(reglas)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      if (r.style.getPropertyValue('font-family').replace(/["']/g, '') !== familia) continue;
      if (/U\+0-FF(?![0-9A-F])/i.test(r.style.getPropertyValue('unicode-range'))) return r;
    }
  }
  return null;
}
