import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@vault/db"],
  poweredByHeader: false,
  // The app shows no images through next/image, so the image optimizer (/_next/image) is off: it is a public
  // endpoint that fetches and re-encodes whatever it is pointed at, and wrote to a read-only cache (M1.3 T8).
  images: { unoptimized: true },
};

export default nextConfig;
