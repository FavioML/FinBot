"use client";

import { useState } from "react";

interface PDFDownloadProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

export default function PDFDownload({ dashboardRef }: PDFDownloadProps) {
  const [isGenerating, setIsGenerating] = useState(false);

  async function handleDownload() {
    if (!dashboardRef.current || isGenerating) return;

    setIsGenerating(true);
    try {
      const { toPng } = await import("html-to-image");
      const jspdfModule = await import("jspdf");
      const jsPDF =
        (jspdfModule as unknown as { jsPDF: typeof jspdfModule.jsPDF }).jsPDF ||
        (jspdfModule as unknown as { default: typeof jspdfModule.jsPDF }).default;

      const el = dashboardRef.current;

      // Capture with html-to-image (handles modern CSS, oklch/oklab, etc.)
      const dataUrl = await toPng(el, {
        backgroundColor: "#0E0E0C",
        pixelRatio: 2,
        cacheBust: true,
        filter: (node: HTMLElement) => {
          // Exclude the PDF download button itself from capture
          if (node.tagName === "BUTTON" && node.textContent?.includes("Descargar")) {
            return false;
          }
          return true;
        },
      });

      // Create image to get dimensions
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = dataUrl;
      });

      const imgWidth = 210; // A4 width in mm
      const pageHeight = 297; // A4 height in mm
      const imgHeight = (img.height * imgWidth) / img.width;

      const pdf = new jsPDF("p", "mm", "a4");
      let heightLeft = imgHeight;
      let position = 0;

      // First page
      pdf.addImage(dataUrl, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      // Additional pages
      while (heightLeft > 0) {
        position -= pageHeight;
        pdf.addPage();
        pdf.addImage(dataUrl, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save("NETO-Dashboard.pdf");
    } catch (error) {
      console.error("Error generating PDF:", error);
      alert("Error al generar el PDF. Intenta de nuevo.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <button
      onClick={handleDownload}
      disabled={isGenerating}
      className="flex items-center gap-2 rounded-full bg-neto-green px-6 py-3 text-[14px] font-medium text-white transition-all hover:bg-neto-green-dark hover:shadow-[0_0_30px_rgba(29,158,117,0.3)] disabled:opacity-70"
    >
      {isGenerating ? (
        <>
          <svg
            className="h-[18px] w-[18px] animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Generando...
        </>
      ) : (
        <>
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 3v9" />
            <path d="M5.5 8.5L9 12l3.5-3.5" />
            <path d="M3 15h12" />
          </svg>
          Descargar PDF
        </>
      )}
    </button>
  );
}
