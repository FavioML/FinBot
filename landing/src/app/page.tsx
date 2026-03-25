import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import BankStrip from "@/components/BankStrip";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import Comparison from "@/components/Comparison";
import Testimonials from "@/components/Testimonials";
import Security from "@/components/Security";
import Pricing from "@/components/Pricing";
import Referral from "@/components/Referral";
import FinalCTA from "@/components/FinalCTA";
import Footer from "@/components/Footer";
import StickyCTA from "@/components/StickyCTA";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <BankStrip />
        <HowItWorks />
        <Features />
        <Comparison />
        <Testimonials />
        <Security />
        <Pricing />
        <Referral />
        <FinalCTA />
      </main>
      <Footer />
      <StickyCTA />
    </>
  );
}
