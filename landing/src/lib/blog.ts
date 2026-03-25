export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  readingTime: string;
  keywords: string[];
  content: string; // HTML content
}

/** Central registry — import from here, add new posts to the array. */
export const posts: BlogPost[] = [
  {
    slug: "gastos-hormiga-peru",
    title:
      "Gastos hormiga: qué son y cómo te roban S/200 al mes sin que te des cuenta",
    description:
      "Descubre qué son los gastos hormiga, cuánto dinero pierdes al mes en Perú y cómo controlarlos automáticamente con WhatsApp.",
    date: "2026-03-21",
    readingTime: "5 min",
    keywords: [
      "gastos hormiga",
      "gastos hormiga peru",
      "gastos innecesarios",
      "ahorro peru",
      "control de gastos",
    ],
    content: "",
  },
  {
    slug: "como-controlar-gastos-personales-peru",
    title: "Cómo controlar tus gastos personales en Perú: guía práctica 2026",
    description:
      "Guía paso a paso para controlar tus gastos en Perú. Métodos probados, herramientas gratuitas y tips adaptados a la realidad peruana.",
    date: "2026-03-22",
    readingTime: "6 min",
    keywords: [
      "cómo controlar gastos personales",
      "control de gastos perú",
      "finanzas personales perú",
      "presupuesto personal",
      "ahorrar dinero perú",
    ],
    content: "",
  },
  {
    slug: "en-que-gasto-mi-plata",
    title: "En qué gasto mi plata: cómo saberlo en 2 minutos por WhatsApp",
    description:
      "¿No sabes a dónde se va tu sueldo? Aprende cómo ver todos tus gastos organizados automáticamente sin anotar nada a mano.",
    date: "2026-03-22",
    readingTime: "4 min",
    keywords: [
      "en qué gasto mi plata",
      "a dónde se va mi dinero",
      "control de gastos whatsapp",
      "rastrear gastos automáticamente",
      "gastos por categoría",
    ],
    content: "",
  },
  {
    slug: "bancos-peru-rastrear-sin-contrasena",
    title: "11 bancos peruanos que puedes rastrear sin dar tu contraseña",
    description:
      "BCP, BBVA, Interbank, Scotiabank, Yape y más. Conoce qué bancos puedes monitorear automáticamente sin compartir tus credenciales bancarias.",
    date: "2026-03-22",
    readingTime: "5 min",
    keywords: [
      "bancos perú",
      "app finanzas perú sin contraseña",
      "rastrear gastos bcp",
      "monitorear banco automáticamente",
      "seguridad financiera perú",
    ],
    content: "",
  },
  {
    slug: "asistente-financiero-whatsapp-peru",
    title: "Asistente financiero por WhatsApp: qué es y cómo funciona Neto",
    description:
      "Neto es el primer asistente financiero peruano que funciona 100% por WhatsApp. Conoce cómo te ayuda a ordenar tu plata automáticamente.",
    date: "2026-03-22",
    readingTime: "5 min",
    keywords: [
      "asistente financiero whatsapp",
      "asistente financiero perú",
      "neto finanzas",
      "bot whatsapp finanzas",
      "control de gastos automático",
    ],
    content: "",
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}

export function getAllSlugs(): string[] {
  return posts.map((p) => p.slug);
}
