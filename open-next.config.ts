import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Defaults: no incremental cache. The app is stateless (run state lives in Upstash) and every
// route is force-dynamic, so there is nothing to cache at the edge.
export default defineCloudflareConfig({});
