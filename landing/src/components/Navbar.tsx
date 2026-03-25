"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";

const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const NAV_LINKS = [
  { label: "Cómo funciona", href: "/#como-funciona" },
  { label: "Precios", href: "/#precios" },
  { label: "Blog", href: "/blog" },
  { label: "FAQ", href: "/faq" },
];

function NetoLogo() {
  return (
    <a href="/" className="flex items-center gap-2 cursor-pointer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-icon.svg" alt="Neto" width={32} height={32} className="rounded-lg" />
      <span className="text-neto-green font-semibold text-lg tracking-tight">
        neto
      </span>
    </a>
  );
}

export default function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="fixed top-0 inset-x-0 z-50 bg-neto-bg/92 backdrop-blur-2xl border-b border-white/5">
      <div className="mx-auto max-w-[1200px] px-6 h-16 flex items-center justify-between">
        <NetoLogo />

        {/* Desktop links */}
        <div className="hidden min-[860px]:flex items-center gap-8">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-neto-txt2 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              {l.label}
            </a>
          ))}
          <a
            href="https://app.neto.pe"
            className="text-sm font-medium text-neto-green hover:text-neto-green-light transition-colors duration-200 cursor-pointer"
          >
            Iniciar sesion
          </a>
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-neto-green px-5 py-2 text-sm font-medium text-white hover:bg-neto-green-dark transition-colors duration-200 cursor-pointer"
          >
            Empezar gratis
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setOpen(!open)}
          className="min-[860px]:hidden text-neto-txt2 hover:text-neto-txt cursor-pointer"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
        >
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="min-[860px]:hidden bg-neto-bg2 border-b border-white/5 px-6 py-6 flex flex-col gap-4">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="text-sm text-neto-txt2 hover:text-neto-txt transition-colors duration-200 cursor-pointer"
            >
              {l.label}
            </a>
          ))}
          <a
            href="https://app.neto.pe"
            className="text-sm font-medium text-neto-green text-center cursor-pointer"
          >
            Iniciar sesion
          </a>
          <a
            href={WA_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-neto-green px-5 py-2.5 text-sm font-medium text-white text-center hover:bg-neto-green-dark transition-colors duration-200 cursor-pointer"
          >
            Empezar gratis
          </a>
        </div>
      )}
    </nav>
  );
}
