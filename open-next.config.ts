import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache, tag cache, or queue overrides on purpose: those need R2/D1/DO
// bindings, which are not free-plan friendly. SSR works without them.
export default defineCloudflareConfig({});
