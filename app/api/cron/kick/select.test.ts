import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_KICKS, STALE_AFTER_MS, selectStale } from "./select";
import type { Run, RunStatus } from "@/lib/types";

const NOW = 10_000_000_000;

function run(id: string, status: RunStatus, updatedAt: number): Run {
  return {
    id,
    ownerId: "email:alice@example.com",
    task: "t",
    status,
    tokens: 0,
    agents: [],
    approvals: [],
    events: [],
    createdAt: 0,
    updatedAt,
    deadlineAt: NOW + 1,
  };
}

describe("selectStale", () => {
  test("picks runs not updated for more than 3 minutes, oldest first", () => {
    const picked = selectStale(
      [
        run("fresh", "running", NOW - 1000),
        run("older", "running", NOW - STALE_AFTER_MS - 5000),
        run("oldest", "planning", NOW - STALE_AFTER_MS - 60_000),
      ],
      NOW,
    );
    assert.deepEqual(picked.map((r) => r.id), ["oldest", "older"]);
  });

  test("a run exactly at the cutoff is not yet stale", () => {
    assert.deepEqual(selectStale([run("edge", "running", NOW - STALE_AFTER_MS)], NOW), []);
  });

  test("skips waiting_approval, done, and failed runs", () => {
    const old = NOW - STALE_AFTER_MS - 1;
    const picked = selectStale(
      [
        run("approval", "waiting_approval", old),
        run("done", "done", old),
        run("failed", "failed", old),
        run("queued", "queued", old),
      ],
      NOW,
    );
    assert.deepEqual(picked.map((r) => r.id), ["queued"]);
  });

  test("ignores missing runs", () => {
    assert.deepEqual(selectStale([null, null], NOW), []);
  });

  test("caps the result at MAX_KICKS", () => {
    const old = NOW - STALE_AFTER_MS - 1;
    const runs = Array.from({ length: MAX_KICKS + 5 }, (_, i) => run(`r${i}`, "running", old - i));
    const picked = selectStale(runs, NOW);
    assert.equal(picked.length, MAX_KICKS);
    assert.equal(picked[0].id, `r${MAX_KICKS + 4}`);
  });
});
