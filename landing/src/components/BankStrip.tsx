const BANKS = [
  "BCP",
  "BBVA Perú",
  "Interbank",
  "Scotiabank",
  "Yape",
  "Plin",
  "+ otros a solicitud",
];

export default function BankStrip() {
  return (
    <section className="bg-neto-bg2 border-t border-b border-white/5 py-8">
      <div className="mx-auto max-w-[1200px] px-6">
        <p className="text-center text-sm text-neto-txt3 mb-5">
          Compatible con tu banco y billetera
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {BANKS.map((name) => (
            <span
              key={name}
              className="rounded-full border border-white/10 bg-neto-bg3 px-4 py-1.5 text-sm text-neto-txt2"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
