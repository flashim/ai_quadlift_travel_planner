import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voyage — Multi-Agent Travel Planner",
  description:
    "Natural-language travel planning orchestrated across discoverable agents: destination research, weather, and itinerary synthesis.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
