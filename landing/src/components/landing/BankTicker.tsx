const BANKS = [
  "BCP",
  "BBVA",
  "Interbank",
  "Scotiabank",
  "Yape",
  "Plin",
  "Falabella",
  "Ripley",
  "BanBif",
  "Mibanco",
];

export default function BankTicker() {
  const items = [...BANKS, ...BANKS];

  return (
    <section
      className="bg-neto-bg2 border-t border-b border-white/5 py-4 overflow-hidden relative"
      aria-label="Bancos compatibles"
    >
      {/* Fade edges */}
      <div className="absolute left-0 top-0 w-20 h-full z-10 bg-gradient-to-r from-neto-bg2 to-transparent pointer-events-none" />
      <div className="absolute right-0 top-0 w-20 h-full z-10 bg-gradient-to-l from-neto-bg2 to-transparent pointer-events-none" />

      <div className="flex gap-6 w-max animate-marquee">
        {items.map((bank, i) => (
          <span key={i} className="flex items-center gap-6">
            <span className="rounded-full border border-white/[0.08] bg-neto-bg3 px-4 py-1.5 text-sm text-neto-txt2 whitespace-nowrap">
              {bank}
            </span>
            <span className="text-neto-txt3 text-xs">·</span>
          </span>
        ))}
      </div>
    </section>
  );
}
