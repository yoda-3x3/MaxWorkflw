# Auto-deploy

`.github/workflows/deploy.yml` deploys to Cloudflare on every push to `main`. It also runs by hand
from the Actions tab (`workflow_dispatch`).

- **Worker** (`workflwpro`): `npm run deploy` builds with OpenNext and deploys. Runs on every push.
- **Pages proxy** (`workflwpro.pages.dev`): `npm run deploy:pages`. Runs only when files under
  `pages-proxy/` changed in the push. A manual run deploys both. The Worker deploys first.

Worker runtime secrets and vars are not touched by the workflow. They stay as configured in
Cloudflare: the vars in `wrangler.jsonc`, and secrets set with `wrangler secret put`.

If the secrets are missing, both jobs are skipped with a notice in the run summary. The run does
not fail red.

## Repo secrets

Add these under the repo's **Settings → Secrets and variables → Actions**:

| Secret                  | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | An API token with the permissions below.                                |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID. It is on the right side of the Cloudflare dashboard home page. |

### Token permissions

Create the token under **My Profile → API Tokens → Create Token → Create Custom Token**. Grant:

- **Account → Workers Scripts → Edit**: deploys the Worker.
- **Account → Cloudflare Pages → Edit**: deploys the Pages proxy.
- **Account → Account Settings → Read**: lets wrangler read the account.

Limit **Account Resources** to the one account that owns `workflwpro`.

## Known issue: the Pages project is git-connected

The Cloudflare dashboard's Pages project `workflwpro` is connected to this repo's root. It has no
build command, so each git build fails with:

```
Output directory "public" not found.
```

The workflow deploys this project itself with `wrangler pages deploy`, so the git connection is not
needed. Fix it in the dashboard with one of these:

1. **Preferred: disconnect git.** Open the `workflwpro` Pages project, go to **Settings → Source
   (or Builds & deployments)**, and disconnect the repository. Deploys then come only from the
   workflow.
2. **Or point the git build at the proxy.** Set the **Root directory** to `pages-proxy`, leave
   **Build command** empty, and set **Build output directory** to `public`.

Either fix stops the failing git builds. Option 1 keeps a single deploy path.
