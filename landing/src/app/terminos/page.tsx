import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Terminos de Uso - Neto",
  description:
    "Terminos de uso de Neto - Tu asistente financiero personal por WhatsApp",
};

export default function TerminosPage() {
  return (
    <>
      <Navbar />
      <main className="bg-neto-bg min-h-screen">
        <article className="mx-auto max-w-[800px] px-6 pt-28 pb-20 md:pt-32">
          {/* Header */}
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-neto-green mb-3">
            <span className="w-4 h-[2px] bg-neto-green" />
            Legal
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">
            Terminos de Uso
          </h1>
          <p className="text-sm text-neto-txt3 mb-10 pb-6 border-b border-white/7">
            Ultima actualizacion: marzo 2026 · Al usar Neto, aceptas estos
            terminos.
          </p>

          {/* Content */}
          <div className="space-y-8">
            {/* Highlight box */}
            <div className="bg-neto-bg3 border border-white/7 border-l-[3px] border-l-neto-amber rounded-r-xl p-4">
              <p className="text-sm text-neto-txt2">
                <strong>Importante:</strong> Neto es una herramienta de analisis
                financiero personal. No somos una entidad financiera regulada
                por la SBS, no ofrecemos asesoria de inversiones ni credito.
              </p>
            </div>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                1. Descripcion del servicio
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Neto es un asistente financiero personal que opera a traves de
                WhatsApp. El servicio lee automaticamente los correos de
                notificacion de transacciones de bancos y billeteras digitales
                peruanas, categoriza los gastos con inteligencia artificial y
                genera resumenes y reportes financieros personales.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                2. Aceptacion de los terminos
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Al registrarte en Neto y autorizar el acceso a tu Gmail, aceptas
                estos Terminos de Uso y nuestra{" "}
                <a
                  href="/privacidad"
                  className="text-neto-green hover:underline"
                >
                  Politica de Privacidad
                </a>
                . Si no estas de acuerdo con alguno de estos terminos, no debes
                usar el servicio.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                3. Registro y cuenta
              </h2>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Para usar Neto necesitas un numero de WhatsApp activo y una
                  cuenta de Gmail.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Eres responsable de mantener la seguridad de tu cuenta.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Debes tener al menos 18 anos para usar el servicio.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Solo puedes tener una cuenta activa por numero de WhatsApp.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                4. Planes y pagos
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-2">
                <strong>Plan Gratis:</strong> acceso permanente a
                funcionalidades basicas sin costo. No requiere tarjeta de
                credito.
              </p>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                <strong>Plan Pro:</strong> S/10.00 por mes o S/99.00 por ano. El
                cobro es recurrente y se realiza automaticamente. Puedes
                cancelar en cualquier momento desde tu cuenta.
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Los precios incluyen IGV cuando aplica.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No ofrecemos reembolsos por periodos parciales ya iniciados.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Si cancelas, mantienes el acceso Pro hasta el final del
                  periodo pagado.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Aceptamos pago con Yape, tarjeta de debito y tarjeta de
                  credito.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                5. Uso aceptable
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Al usar Neto, te comprometes a:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Usar el servicio unicamente para fines personales y legales.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No intentar acceder a datos de otros usuarios.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No usar el servicio para actividades fraudulentas o ilegales.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No intentar manipular, hackear o alterar el funcionamiento del
                  servicio.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                6. Limitaciones del servicio
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Neto es una herramienta de organizacion y visualizacion
                financiera personal. Por lo tanto:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Los resumenes y reportes son referenciales y dependen de la
                  calidad de los correos bancarios recibidos.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No garantizamos que todos los correos de transacciones sean
                  detectados y procesados.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Las categorias asignadas por IA pueden no ser siempre exactas
                  - puedes corregirlas manualmente.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Neto no constituye asesoria financiera, legal ni tributaria.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                7. Disponibilidad del servicio
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Nos esforzamos por mantener el servicio disponible 24/7, pero no
                garantizamos disponibilidad ininterrumpida. Podemos realizar
                mantenimientos programados con aviso previo. No somos
                responsables por danos derivados de interrupciones del servicio.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                8. Propiedad intelectual
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                El nombre &quot;Neto&quot;, el logo, el diseno y todo el
                contenido del sitio web y la aplicacion son propiedad de Neto.
                No puedes reproducir, distribuir ni crear obras derivadas sin
                autorizacion expresa por escrito.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                9. Cancelacion y eliminacion de cuenta
              </h2>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Puedes cancelar tu cuenta en cualquier momento escribiendo a{" "}
                  <a
                    href="mailto:hola@neto.pe"
                    className="text-neto-green hover:underline"
                  >
                    hola@neto.pe
                  </a>
                  .
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Al cancelar, tus datos seran eliminados en un plazo maximo de
                  30 dias.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Nos reservamos el derecho de suspender o cancelar cuentas que
                  violen estos terminos.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                10. Modificaciones
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Podemos modificar estos terminos en cualquier momento. Te
                notificaremos por WhatsApp con al menos 7 dias de anticipacion
                ante cambios significativos. El uso continuado del servicio tras
                los cambios implica aceptacion.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                11. Ley aplicable
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Estos terminos se rigen por las leyes de la Republica del Peru.
                Cualquier controversia sera resuelta ante los tribunales
                competentes de Lima, Peru.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                12. Contacto
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Para consultas sobre estos terminos:{" "}
                <a
                  href="mailto:hola@neto.pe"
                  className="text-neto-green hover:underline"
                >
                  hola@neto.pe
                </a>{" "}
                o{" "}
                <a
                  href="https://wa.me/51933014505"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neto-green hover:underline"
                >
                  +51 933 014 505
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
