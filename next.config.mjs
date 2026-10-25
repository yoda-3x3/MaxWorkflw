/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Stateless serverless: no build-time filesystem assumptions, no standalone output.
  poweredByHeader: false,
  // Camera/gesture code needs the Permissions-Policy to allow the camera on our own origin.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: "camera=(self)" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
