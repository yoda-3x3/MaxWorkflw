import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCountLabel,
  deadlineLabel,
  deadlineProgress,
  formatDuration,
  formatTokens,
  isDraft,
  isRunnerStarting,
  prLabel,
  statusLabel,
  timeAgo,
  usageLabel,
  usagePercent,
  usageResetLabel,
} from "./format";

test("formatDuration picks the right unit", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(Number.NaN), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(3 * 60_000 + 5_000), "3m 05s");
  assert.equal(formatDuration(2 * 3_600_000 + 10 * 60_000), "2h 10m");
  assert.equal(formatDuration(26 * 3_600_000), "1d 2h");
});

test("deadlineLabel reports time left or that it has passed", () => {
  assert.equal(deadlineLabel(1_000, 2_000), "deadline passed");
  assert.equal(deadlineLabel(10_000 + 5 * 60_000, 10_000), "5m 00s left");
});

test("formatTokens compacts large counts", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_400), "12.4k");
  assert.equal(formatTokens(1_300_000), "1.3M");
});

test("agentCountLabel shows the cap", () => {
  assert.equal(agentCountLabel(4), "4/30");
});

test("deadlineProgress is clamped to [0, 1]", () => {
  assert.equal(deadlineProgress(0, 100, 50), 0.5);
  assert.equal(deadlineProgress(0, 100, 500), 1);
  assert.equal(deadlineProgress(0, 100, -5), 0);
});

test("timeAgo buckets by size", () => {
  assert.equal(timeAgo(1_000, 1_000), "just now");
  assert.equal(timeAgo(0, 5 * 60_000), "5m ago");
  assert.equal(timeAgo(0, 3 * 3_600_000), "3h ago");
  assert.equal(timeAgo(0, 2 * 86_400_000), "2d ago");
});

test("isRunnerStarting is true only while queued with no agent started", () => {
  assert.equal(isRunnerStarting({ status: "queued", agents: [] }), true);
  assert.equal(isRunnerStarting({ status: "queued", agents: [{ status: "queued" }] }), true);
  assert.equal(isRunnerStarting({ status: "queued", agents: [{ status: "running" }] }), false);
  assert.equal(isRunnerStarting({ status: "planning", agents: [] }), false);
  assert.equal(isRunnerStarting({ status: "done", agents: [] }), false);
});

test("isDraft is true only for the draft status, and a draft is never runner-starting", () => {
  assert.equal(isDraft({ status: "draft" }), true);
  assert.equal(isDraft({ status: "queued" }), false);
  assert.equal(isRunnerStarting({ status: "draft", agents: [] }), false);
});

test("statusLabel shows draft plainly and spaces out underscores", () => {
  assert.equal(statusLabel("draft"), "draft");
  assert.equal(statusLabel("waiting_approval"), "waiting approval");
  assert.equal(statusLabel("done"), "done");
});

test("prLabel needs both repo and PR number", () => {
  assert.equal(prLabel("yoda-3x3/WorkflwPro", 12), "yoda-3x3/WorkflwPro#12");
  assert.equal(prLabel(undefined, 12), null);
  assert.equal(prLabel("a/b", undefined), null);
});

test("usage helpers: percent scale, labels, reset text", () => {
  assert.equal(usagePercent(0.88), 88);
  assert.equal(usagePercent(88), 88);
  assert.equal(usagePercent(undefined), 0);
  assert.equal(usageLabel("five_hour"), "5-hour");
  assert.equal(usageLabel("seven_day"), "7-day");
  assert.equal(usageLabel("other_thing"), "other thing");
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  assert.equal(usageResetLabel((now - 1000) / 1000, now), "reset now");
  assert.match(usageResetLabel((now + 2.5 * 3_600_000) / 1000, now), /· in 2h 30m$/);
});
