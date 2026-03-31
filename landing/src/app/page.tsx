import dynamic from "next/dynamic";
import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import BankTicker from "@/components/landing/BankTicker";

const BentoShowcase = dynamic(() => import("@/components/landing/BentoShowcase"));
const HowItWorks = dynamic(() => import("@/components/landing/HowItWorks"));
const Security = dynamic(() => import("@/components/landing/Security"));
const Testimonials = dynamic(() => import("@/components/landing/Testimonials"));
const Pricing = dynamic(() => import("@/components/landing/Pricing"));
const FinalCTA = dynamic(() => import("@/components/landing/FinalCTA"));
const Footer = dynamic(() => import("@/components/landing/Footer"));
const StickyCTA = dynamic(() => import("@/components/landing/StickyCTA"));
const ExitIntent = dynamic(() => import("@/components/landing/ExitIntent"));

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <BankTicker />
        <BentoShowcase />
        <HowItWorks />
        <Security />
        <Testimonials />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
      <StickyCTA />
      <ExitIntent />
    </>
  );
}
