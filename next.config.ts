import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `pg` and the AWS SDK must stay external to the server bundle. Bundling them
   * breaks native bindings and blows up cold-start size for no benefit.
   */
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
  eslint: {
    // Linting runs separately, not as part of the build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
