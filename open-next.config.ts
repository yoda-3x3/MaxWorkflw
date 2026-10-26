import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Defaults are fine: no R2 incremental cache or image optimization binding yet.
// The app is stateless (run state lives in Upstash Redis), so no cache binding is needed.
export default defineCloudflareConfig({});
