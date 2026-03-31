import type { Metadata } from "next";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";

export const metadata: Metadata = {
  title: "Politica de Privacidad - Neto",
  description:
    "Politica de privacidad de Neto - Tu asistente financiero personal por WhatsApp",
};

export default function PrivacidadPage() {
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
            Politica de Privacidad
          </h1>
          <p className="text-sm text-neto-txt3 mb-10 pb-6 border-b border-white/7">
            Ultima actualizacion: marzo 2026 · Aplicable a usuarios de neto.pe
            y el servicio Neto por WhatsApp
          </p>

          {/* Content */}
          <div className="space-y-8">
            {/* Highlight box */}
            <div className="bg-neto-bg3 border border-white/7 border-l-[3px] border-l-neto-green rounded-r-xl p-4">
              <p className="text-sm text-neto-txt2">
                <strong>Resumen simple:</strong> Neto solo accede a tus correos
                de notificacion de transacciones bancarias. Nunca leemos correos
                personales, nunca almacenamos contrasenas, y nunca vendemos tus
                datos a terceros.
              </p>
            </div>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                1. Quienes somos
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Neto es un servicio de asistente financiero personal que opera a
                traves de WhatsApp. Nuestros datos de contacto son:{" "}
                <a
                  href="mailto:hola@neto.pe"
                  className="text-neto-green hover:underline"
                >
                  hola@neto.pe
                </a>{" "}
                y{" "}
                <a
                  href="https://neto.pe"
                  className="text-neto-green hover:underline"
                >
                  neto.pe
                </a>
                . Operamos desde Lima, Peru.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                2. Que datos recopilamos
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Recopilamos unicamente los datos necesarios para brindarte el
                servicio:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Numero de WhatsApp:</strong> para enviarte resumenes y
                  notificaciones.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Correos de notificacion bancaria:</strong> solo los
                  correos automaticos que tu banco envia por cada transaccion
                  (ej. &quot;Se realizo un cargo de S/50 en tu tarjeta&quot;).
                  No accedemos a correos personales, laborales ni de ningun otro
                  tipo.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Datos de transacciones:</strong> montos, comercios,
                  fechas y categorias extraidas de los correos bancarios.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Datos de cuenta:</strong> nombre, numero de telefono y
                  preferencias de configuracion del servicio.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                3. Como usamos tus datos
              </h2>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Generar resumenes de gastos y enviartelos por WhatsApp.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Categorizar tus transacciones automaticamente con inteligencia
                  artificial.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Elaborar tu reporte mensual de salud financiera.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Enviarte alertas sobre gastos inusuales o superacion de
                  promedios.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Mejorar la precision de categorizacion y el funcionamiento del
                  servicio.
                </li>
              </ul>
              <p className="text-sm text-neto-txt2 leading-7 mt-3">
                <strong>No usamos tus datos para:</strong> publicidad de
                terceros, perfilamiento comercial, venta a otras empresas, ni
                ningun fin distinto a brindarte el servicio.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                4. Acceso a Gmail
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Neto solicita acceso limitado a tu cuenta de Gmail bajo el
                estandar OAuth 2.0 de Google. Este acceso es especifico y
                restringido a:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Lectura de correos identificados como notificaciones de
                  transacciones de bancos y billeteras digitales peruanas.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  No leemos, almacenamos ni procesamos ningun otro correo de tu
                  bandeja de entrada.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Puedes revocar este acceso en cualquier momento desde tu
                  cuenta de Google en:{" "}
                  <a
                    href="https://myaccount.google.com/permissions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neto-green hover:underline"
                  >
                    myaccount.google.com/permissions
                  </a>
                  .
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                5. Almacenamiento y seguridad
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Tus datos se almacenan en servidores seguros (Supabase) con las
                siguientes medidas:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Cifrado en transito (HTTPS/TLS) y en reposo.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Acceso restringido por nivel de usuario (Row Level Security):
                  solo tu puedes ver tus propios datos.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  Tokens de acceso a Gmail cifrados y nunca expuestos en texto
                  plano.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                6. Comparticion de datos con terceros
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                Neto utiliza los siguientes proveedores de servicios para
                operar:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>OpenAI:</strong> procesamiento de lenguaje natural
                  para categorizacion y resumenes (datos de transacciones
                  anonimizados).
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Supabase:</strong> almacenamiento de base de datos.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Meta (WhatsApp Business API):</strong> envio de
                  mensajes.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Railway:</strong> infraestructura de servidores.
                </li>
              </ul>
              <p className="text-sm text-neto-txt2 leading-7 mt-3">
                No vendemos, alquilamos ni compartimos tus datos con ninguna
                otra empresa, anunciante o tercero.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                7. Tus derechos (Ley 29733 - Peru)
              </h2>
              <p className="text-sm text-neto-txt2 leading-7 mb-3">
                De acuerdo con la Ley de Proteccion de Datos Personales del Peru
                (Ley N 29733), tienes derecho a:
              </p>
              <ul className="space-y-2">
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Acceso:</strong> solicitar que datos tenemos sobre ti.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Rectificacion:</strong> corregir datos inexactos.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Cancelacion:</strong> solicitar la eliminacion de tus
                  datos.
                </li>
                <li className="text-sm text-neto-txt2 leading-7 pl-5 relative before:content-['\2014'] before:absolute before:left-0 before:text-neto-green before:font-semibold">
                  <strong>Oposicion:</strong> oponerte al tratamiento de tus
                  datos.
                </li>
              </ul>
              <p className="text-sm text-neto-txt2 leading-7 mt-3">
                Para ejercer cualquiera de estos derechos, escribenos a{" "}
                <a
                  href="mailto:hola@neto.pe"
                  className="text-neto-green hover:underline"
                >
                  hola@neto.pe
                </a>{" "}
                con el asunto &quot;Derechos ARCO&quot;.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                8. Retencion de datos
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Conservamos tus datos mientras uses el servicio activamente. Si
                solicitas la cancelacion de tu cuenta, eliminamos todos tus
                datos en un plazo maximo de 30 dias, excepto aquellos que
                debamos conservar por obligacion legal.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                9. Cambios a esta politica
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Si realizamos cambios significativos a esta politica, te
                notificaremos por WhatsApp con al menos 7 dias de anticipacion
                antes de que entren en vigor.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold tracking-tight mb-3">
                10. Contacto
              </h2>
              <p className="text-sm text-neto-txt2 leading-7">
                Para cualquier consulta sobre privacidad:{" "}
                <a
                  href="mailto:hola@neto.pe"
                  className="text-neto-green hover:underline"
                >
                  hola@neto.pe
                </a>{" "}
                o escribenos por{" "}
                <a
                  href="https://wa.me/51933014505"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neto-green hover:underline"
                >
                  WhatsApp al +51 933 014 505
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
