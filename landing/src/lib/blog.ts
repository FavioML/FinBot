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
    content: "", // filled in the article file
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug);
}

export function getAllSlugs(): string[] {
  return posts.map((p) => p.slug);
}
