import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BAWAAL — desi party games",
    short_name: "BAWAAL",
    description: "14 desi party games for family and friends. Big screen on the TV, everyone joins from their phones, no app needed.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbf6ee",
    theme_color: "#fbf6ee",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
