"use client";

import type { Agent, RunEvent } from "../../lib/types";

interface Props {
  events: RunEvent[];
  agents: Agent[];
}

export function ActivityLog({ events, agents }: Props) {
  // Newest first, so the latest action is visible without scrolling.
  const rows = [...events].reverse();
  return (
    <section className="activity" aria-label="Activity log">
      <h2>Activity</h2>
      {rows.length === 0 && <p className="muted">Nothing yet.</p>}
      <ol>
        {rows.map((e, i) => {
          const agent = e.agentId ? agents.find((a) => a.id === e.agentId) : undefined;
          return (
            <li key={`${e.at}-${i}`}>
              <time dateTime={new Date(e.at).toISOString()}>
                {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </time>
              {agent && <span className="activity-agent">{agent.title}</span>}
              <span>{e.message}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
