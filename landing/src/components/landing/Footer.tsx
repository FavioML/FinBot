const WA_LINK =
  "https://wa.me/51933014505?text=Hola%20Neto%2C%20quiero%20empezar%20a%20ordenar%20mis%20finanzas%20%F0%9F%91%8B";

const PRODUCT_LINKS = [
  { label: "Cómo funciona", href: "/#como-funciona" },
  { label: "Precios", href: "/#precios" },
  { label: "Dashboard", href: "https://app.neto.pe" },
  { label: "Blog", href: "/blog" },
  { label: "FAQ", href: "/faq" },
];

const CONTACT_LINKS = [
  { label: "hola@neto.pe", href: "mailto:hola@neto.pe" },
  { label: "WhatsApp", href: WA_LINK, target: "_blank" },
];

const LEGAL_LINKS = [
  { label: "Privacidad", href: "/privacidad" },
  { label: "Términos", href: "/terminos" },
];

const SOCIAL_LINKS = [
  { label: "IG", href: "https://www.instagram.com/neto_peru/", aria: "Instagram" },
  { label: "FB", href: "https://www.facebook.com/profile.php?id=61578664208419", aria: "Facebook" },
  { label: "TK", href: "https://www.tiktok.com/@neto_peru", aria: "TikTok" },
];

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-widest text-neto-txt3 mb-4">{title}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="bg-neto-bg2 pt-16 pb-8">
      <div className="mx-auto max-w-[1200px] px-6">
        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-8">
          {/* Col 1 — Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <a href="/" className="flex items-center gap-2 mb-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-icon.svg" alt="Neto" width={28} height={28} className="rounded-lg" />
              <span className="text-neto-green font-semibold text-lg tracking-tight">neto</span>
            </a>
            <p className="text-sm text-neto-txt3 leading-relaxed mb-5 max-w-[260px]">
              Somos un equipo peruano construyendo el asistente financiero que nos hubiera gustado
              tener.
            </p>
            <div className="flex items-center gap-2">
              {SOCIAL_LINKS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.aria}
                  className="w-8 h-8 rounded-full bg-neto-bg3 border border-white/10 flex items-center justify-center text-[10px] text-neto-txt2 hover:border-white/20 hover:text-neto-txt transition-colors duration-200"
                >
                  {s.label}
                </a>
              ))}
            </div>
          </div>

          {/* Col 2 — Producto */}
          <FooterCol title="Producto">
            {PRODUCT_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm text-neto-txt3 hover:text-neto-txt2 transition-colors duration-200"
              >
                {l.label}
              </a>
            ))}
          </FooterCol>

          {/* Col 3 — Contacto */}
          <FooterCol title="Contacto">
            {CONTACT_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target={l.target}
                rel={l.target === "_blank" ? "noopener noreferrer" : undefined}
                className="text-sm text-neto-txt3 hover:text-neto-txt2 transition-colors duration-200"
              >
                {l.label}
              </a>
            ))}
          </FooterCol>

          {/* Col 4 — Legal */}
          <FooterCol title="Legal">
            {LEGAL_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm text-neto-txt3 hover:text-neto-txt2 transition-colors duration-200"
              >
                {l.label}
              </a>
            ))}
          </FooterCol>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-8 border-t border-white/5 flex justify-between flex-wrap gap-4">
          <p className="text-sm text-neto-txt3">
            © 2026 Neto · Lima, Perú · un producto de{" "}
            <a
              href="https://vortik.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neto-green hover:text-neto-green-light transition-colors duration-200"
            >
              Vortik
            </a>
          </p>
          <div className="flex items-center gap-4">
            <a
              href="/privacidad"
              className="text-sm text-neto-txt3 hover:text-neto-txt2 transition-colors duration-200"
            >
              Privacidad
            </a>
            <span className="text-neto-txt3 text-sm">|</span>
            <a
              href="/terminos"
              className="text-sm text-neto-txt3 hover:text-neto-txt2 transition-colors duration-200"
            >
              Términos
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
