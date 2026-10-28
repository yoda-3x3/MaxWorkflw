import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  REPO_PAGE_SIZE,
  GitHubRepoError,
  createAccessibleRepo,
  filterRepos,
  listAccessibleRepos,
  parseRepoListQuery,
  selectRepoPage,
  toRepoSummary,
  validateNewRepo,
  validateNewRepoName,
  type GitHubRepoSummary,
} from "@/lib/githubRepos";

const repo = (fullName: string, extra: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary => {
  const [owner, name] = fullName.split("/");
  return { fullName, owner, name, private: false, defaultBranch: "main", ...extra };
};

/** GitHub-shaped item, as returned by GET /user/repos. */
const apiRepo = (fullName: string, priv = false) => {
  const [owner, name] = fullName.split("/");
  return { full_name: fullName, name, owner: { login: owner }, private: priv, default_branch: "main" };
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseRepoListQuery", () => {
  test("defaults when params are missing", () => {
    assert.deepEqual(parseRepoListQuery(new URLSearchParams()), { q: "", page: 1, perPage: 30 });
  });

  test("trims q and caps its length", () => {
    const q = parseRepoListQuery(new URLSearchParams({ q: "  " + "a".repeat(200) + "  " }));
    assert.equal(q.q.length, 100);
    assert.equal(parseRepoListQuery(new URLSearchParams({ q: "  acme  " })).q, "acme");
  });

  test("clamps page and perPage and ignores non-integers", () => {
    const parse = (s: string) => parseRepoListQuery(new URLSearchParams(s));
    assert.equal(parse("page=0").page, 1);
    assert.equal(parse("page=-4").page, 1);
    assert.equal(parse("page=2.5").page, 1);
    assert.equal(parse("page=abc").page, 1);
    assert.equal(parse("perPage=500").perPage, 100);
    assert.equal(parse("perPage=0").perPage, 1);
    assert.equal(parse("perPage=50").perPage, 50);
  });
});

test("filterRepos matches owner/name case-insensitively and keeps order", () => {
  const repos = [repo("Acme/Api"), repo("acme/web"), repo("other/tools")];
  assert.deepEqual(filterRepos(repos, "ACME").map((r) => r.fullName), ["Acme/Api", "acme/web"]);
  assert.deepEqual(filterRepos(repos, "acme/w").map((r) => r.fullName), ["acme/web"]);
  assert.equal(filterRepos(repos, "").length, 3);
  assert.equal(filterRepos(repos, "   ").length, 3);
  assert.equal(filterRepos(repos, "nothing").length, 0);
});

test("selectRepoPage pages the filtered list and reports hasMore", () => {
  const repos = Array.from({ length: 5 }, (_, i) => repo(`acme/r${i}`));
  const first = selectRepoPage(repos, { q: "", page: 1, perPage: 2 }, false);
  assert.deepEqual(first.repos.map((r) => r.name), ["r0", "r1"]);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);

  const last = selectRepoPage(repos, { q: "", page: 3, perPage: 2 }, false);
  assert.deepEqual(last.repos.map((r) => r.name), ["r4"]);
  assert.equal(last.hasMore, false);

  const past = selectRepoPage(repos, { q: "", page: 9, perPage: 2 }, false);
  assert.deepEqual(past.repos, []);
  assert.equal(past.hasMore, false);
});

test("selectRepoPage counts matches for the query, not the whole list, and passes truncated through", () => {
  const repos = [repo("acme/api"), repo("acme/web"), repo("other/x")];
  const page = selectRepoPage(repos, { q: "acme", page: 1, perPage: 1 }, true);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
});

test("toRepoSummary maps the GitHub shape and rejects malformed items", () => {
  assert.deepEqual(toRepoSummary(apiRepo("acme/app", true)), {
    fullName: "acme/app",
    owner: "acme",
    name: "app",
    private: true,
    defaultBranch: "main",
  });
  assert.equal(toRepoSummary(null), null);
  assert.equal(toRepoSummary("acme/app"), null);
  assert.equal(toRepoSummary({ ...apiRepo("acme/app"), private: "yes" }), null);
  assert.equal(toRepoSummary({ ...apiRepo("acme/app"), default_branch: undefined }), null);
  assert.equal(toRepoSummary({ ...apiRepo("acme/app"), owner: undefined }), null);
});

describe("listAccessibleRepos", () => {
  test("reads pages until a short page, drops duplicates, and sends the token only in the header", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const pageOne = Array.from({ length: REPO_PAGE_SIZE }, (_, i) => apiRepo(`acme/r${i}`));
    const pageTwo = [apiRepo("acme/r1"), apiRepo("acme/extra")];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return jsonResponse(200, url.includes("page=1") ? pageOne : pageTwo);
    }) as typeof fetch;

    const out = await listAccessibleRepos({ token: "tok", fetch: fetchFn, apiBase: "https://api.example" });
    assert.equal(out.truncated, false);
    assert.equal(out.repos.length, REPO_PAGE_SIZE + 1);
    assert.equal(seen.length, 2);
    assert.ok(seen[0].url.startsWith("https://api.example/user/repos?per_page=100&page=1"));
    assert.equal(seen[0].auth, "Bearer tok");
    assert.ok(!seen.some((s) => s.url.includes("tok")), "token must not be in the URL");
  });

  test("stops at the page cap and marks the list truncated", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonResponse(200, Array.from({ length: REPO_PAGE_SIZE }, (_, i) => apiRepo(`acme/r${calls}-${i}`)));
    }) as typeof fetch;
    const out = await listAccessibleRepos({ token: "t", fetch: fetchFn, maxPages: 3 });
    assert.equal(calls, 3);
    assert.equal(out.truncated, true);
    assert.equal(out.repos.length, 300);
  });

  test("a non-OK response becomes GitHubRepoError with the status", async () => {
    const fetchFn = (async () => jsonResponse(401, { message: "Bad credentials" })) as typeof fetch;
    await assert.rejects(
      listAccessibleRepos({ token: "t", fetch: fetchFn }),
      (err: unknown) => err instanceof GitHubRepoError && err.status === 401,
    );
  });
});

describe("new repo name rules", () => {
  test("accepts ordinary names", () => {
    for (const name of ["app", "my-app_2", "app.v2", "A", "_private"]) {
      assert.equal(validateNewRepoName(name), null, name);
    }
  });

  test("rejects empty, long, spaced, leading-dot and slash names", () => {
    for (const name of ["", "a b", ".hidden", "a/b", "-flag", "a".repeat(101), "ü"]) {
      assert.notEqual(validateNewRepoName(name), null, JSON.stringify(name));
    }
  });

  test("rejects trailing dot and .git suffix", () => {
    assert.notEqual(validateNewRepoName("app."), null);
    assert.notEqual(validateNewRepoName("app.git"), null);
    assert.notEqual(validateNewRepoName("app.GIT"), null);
  });

  test("validateNewRepo checks description length and the private flag type", () => {
    assert.equal(validateNewRepo({ name: "app" }), null);
    assert.equal(validateNewRepo({ name: "app", description: "x".repeat(350), private: false }), null);
    assert.notEqual(validateNewRepo({ name: "app", description: "x".repeat(351) }), null);
    assert.notEqual(validateNewRepo({ name: "app", private: "yes" as unknown as boolean }), null);
    assert.notEqual(validateNewRepo({ name: "bad name" }), null);
  });
});

describe("createAccessibleRepo", () => {
  test("posts a private, auto-initialised repo by default and returns owner/name", async () => {
    let body: any;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      assert.equal(init?.method, "POST");
      return jsonResponse(201, apiRepo("acme/new-app", true));
    }) as typeof fetch;

    const created = await createAccessibleRepo({ name: "new-app" }, { token: "t", fetch: fetchFn });
    assert.deepEqual(body, { name: "new-app", description: "", private: true, auto_init: true });
    assert.equal(created.fullName, "acme/new-app");
    assert.equal(created.private, true);
  });

  test("an invalid name makes no network call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return jsonResponse(201, {});
    }) as typeof fetch;
    await assert.rejects(createAccessibleRepo({ name: "../x" }, { token: "t", fetch: fetchFn }), GitHubRepoError);
    assert.equal(called, false);
  });

  test("a name that already exists gets a clear message", async () => {
    const fetchFn = (async () =>
      jsonResponse(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] })
    ) as typeof fetch;
    await assert.rejects(
      createAccessibleRepo({ name: "app" }, { token: "t", fetch: fetchFn }),
      (err: unknown) => err instanceof GitHubRepoError && err.status === 422 && /already have a repo named app/.test(err.message),
    );
  });

  test("a 403 explains the token needs permission to create repos", async () => {
    const fetchFn = (async () => jsonResponse(403, { message: "Resource not accessible" })) as typeof fetch;
    await assert.rejects(
      createAccessibleRepo({ name: "app" }, { token: "t", fetch: fetchFn }),
      (err: unknown) => err instanceof GitHubRepoError && /GITHUB_TOKEN needs permission to create repositories/.test(err.message),
    );
  });

  test("the token never appears in an error message", async () => {
    const fetchFn = (async () => jsonResponse(500, { message: "boom" })) as typeof fetch;
    await assert.rejects(
      createAccessibleRepo({ name: "app" }, { token: "SECRET-TOKEN-VALUE", fetch: fetchFn }),
      (err: unknown) => err instanceof Error && !err.message.includes("SECRET-TOKEN-VALUE"),
    );
  });
});
