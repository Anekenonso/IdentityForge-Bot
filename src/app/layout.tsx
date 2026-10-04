import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IdentityForge — auditable agent identity on Walrus Memory",
  description:
    "An agent whose identity lives in Walrus Memory, reconstructible on any machine, any deployment, any LLM — and every claim traceable to a content-addressed blob.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
