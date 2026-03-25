import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { posts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — Neto | Finanzas personales Perú",
  description:
    "Tips, guías y estrategias de finanzas personales para peruanos. Aprende a controlar tus gastos, ahorrar más y ordenar tu plata.",
  alternates: { canonical: "https://neto.pe/blog" },
};

export default function BlogIndex() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-neto-bg pt-28 pb-20">
        <div className="mx-auto max-w-[760px] px-6">
          <p className="text-neto-green text-sm font-medium mb-3">Blog</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Finanzas personales Perú
          </h1>
          <p className="text-neto-txt3 mb-12 max-w-[520px]">
            Tips, guías y estrategias para ordenar tu plata. Sin humo, sin
            jerga financiera — solo lo que funciona.
          </p>

          <div className="space-y-8">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="block group"
              >
                <article className="rounded-2xl border border-white/5 bg-neto-bg2 p-6 sm:p-8 transition-colors duration-200 hover:border-neto-green/30">
                  <time className="text-xs text-neto-txt3 uppercase tracking-wider">
                    {new Date(post.date).toLocaleDateString("es-PE", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                    {" · "}
                    {post.readingTime} lectura
                  </time>
                  <h2 className="text-lg sm:text-xl font-semibold mt-2 mb-2 group-hover:text-neto-green transition-colors duration-200">
                    {post.title}
                  </h2>
                  <p className="text-sm text-neto-txt3 leading-relaxed">
                    {post.description}
                  </p>
                </article>
              </Link>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
