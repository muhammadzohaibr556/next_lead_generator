import { connection } from "next/server";
import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = {
  title: "Permit Atlas · Opportunity intelligence",
  description:
    "Source-backed construction opportunities across connected municipal markets.",
};
export default async function Layout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/static/vendor/tabler-1.5.1.min.css" />
        <link rel="stylesheet" href="/static/vendor/leaflet/leaflet.css" />
        <link
          rel="stylesheet"
          href="/static/vendor/leaflet/MarkerCluster.css"
        />
        <link
          rel="stylesheet"
          href="/static/vendor/leaflet/MarkerCluster.Default.css"
        />
        <link rel="stylesheet" href="/static/style.css?v=atlas-blue-1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
