import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  REPO_SELECT_MANUAL,
  REPO_SELECT_NONE,
  loadRepoPages,
  repoSelectLabel,
  repoSelectOptions,
  selectOptionValue,
  withRepoListed,
  type GitHubRepoSummary,
  type RepoPage,
} from "@/lib/githubRepos";

const repo = (fullName: string, priv = false): GitHubRepoSummary => {
  const [owner, name] = fullName.split("/");
  return { fullName, owner, name, private: priv, defaultBranch: "main" };
};

/** Serves `total` repos in pages of `size`, the way GitHub pages do. */
function fakePages(total: number, size: number, opts: { truncated?: boolean } = {}) {
  const calls: number[] = [];
  const fetchPage = async (page: number): Promise<Pick<RepoPage, "repos" | "hasMore" | "truncated">> => {
    calls.push(page);
    const start = (page - 1) * size;
    const repos = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => repo(`acme/r${start + i}`));
    return { repos, hasMore: start + size < total, truncated: opts.truncated ?? false };
  };
  return { fetchPage, calls };
}

describe("loadRepoPages", () => {
  test("reads every page until GitHub has no more", async () => {
    const { fetchPage, calls } = fakePages(250, 100);
    const out = await loadRepoPages(fetchPage);
    assert.equal(out.repos.length, 250);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(out.truncated, false);
  });

  test("stops at maxRepos and reports the list as truncated", async () => {
    const { fetchPage, calls } = fakePages(1000, 100);
    const out = await loadRepoPages(fetchPage, 300);
    assert.equal(out.repos.length, 300);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(out.truncated, true);
  });

  test("a server-side cap is reported even when the last page has no more", async () => {
    const { fetchPage } = fakePages(5, 100, { truncated: true });
    const out = await loadRepoPages(fetchPage);
    assert.equal(out.repos.length, 5);
    assert.equal(out.truncated, true);
  });

  test("drops duplicates across pages", async () => {
    const pages: RepoPage[] = [
      { repos: [repo("acme/a"), repo("acme/b")], page: 1, perPage: 2, total: 3, hasMore: true, truncated: false },
      { repos: [repo("acme/b"), repo("acme/c")], page: 2, perPage: 2, total: 3, hasMore: false, truncated: false },
    ];
    const out = await loadRepoPages(async (p) => pages[p - 1]);
    assert.deepEqual(out.repos.map((r) => r.fullName), ["acme/a", "acme/b", "acme/c"]);
  });

  test("an empty account gives an empty, not-truncated list", async () => {
    const { fetchPage, calls } = fakePages(0, 100);
    const out = await loadRepoPages(fetchPage);
    assert.deepEqual(out, { repos: [], truncated: false });
    assert.deepEqual(calls, [1]);
  });

  test("a failed page rejects, so the UI can show the error", async () => {
    await assert.rejects(
      loadRepoPages(async () => {
        throw new Error("GITHUB_TOKEN is not configured");
      }),
      /not configured/,
    );
  });
});

describe("selectOptionValue", () => {
  const repos = [repo("acme/app"), repo("acme/web", true)];

  test("a listed repo shows as itself", () => {
    assert.equal(selectOptionValue("acme/web", repos, false), "acme/web");
  });

  test("an empty value shows No repo, unless the manual option was opened", () => {
    assert.equal(selectOptionValue("", repos, false), REPO_SELECT_NONE);
    assert.equal(selectOptionValue("", repos, true), REPO_SELECT_MANUAL);
  });

  test("a typed value that is not listed shows the manual option", () => {
    assert.equal(selectOptionValue("someone/else", repos, false), REPO_SELECT_MANUAL);
    assert.equal(selectOptionValue("someone/else", [], false), REPO_SELECT_MANUAL);
  });
});

describe("repoSelectOptions", () => {
  const repos = [repo("acme/app"), repo("acme/web"), repo("other/tools")];

  test("applies the filter, case-insensitively", () => {
    assert.deepEqual(repoSelectOptions(repos, "ACME", "").map((r) => r.fullName), ["acme/app", "acme/web"]);
    assert.equal(repoSelectOptions(repos, "", "").length, 3);
  });

  test("keeps the selected repo visible even when the filter drops it", () => {
    const out = repoSelectOptions(repos, "other", "acme/app").map((r) => r.fullName);
    assert.deepEqual(out, ["acme/app", "other/tools"]);
  });

  test("does not duplicate the selected repo when the filter already keeps it", () => {
    const out = repoSelectOptions(repos, "acme", "acme/app").map((r) => r.fullName);
    assert.deepEqual(out, ["acme/app", "acme/web"]);
  });
});

describe("withRepoListed", () => {
  test("adds a freshly created repo to the top of the list", () => {
    const out = withRepoListed([repo("acme/app")], repo("acme/new", true));
    assert.deepEqual(out.map((r) => r.fullName), ["acme/new", "acme/app"]);
  });

  test("returns the same array when the repo is already listed", () => {
    const list = [repo("acme/app")];
    assert.equal(withRepoListed(list, repo("acme/app")), list);
  });
});

test("repoSelectLabel shows owner/name and visibility", () => {
  assert.equal(repoSelectLabel(repo("acme/app")), "acme/app (public)");
  assert.equal(repoSelectLabel(repo("acme/app", true)), "acme/app (private)");
});
