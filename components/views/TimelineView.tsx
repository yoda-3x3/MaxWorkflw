'use client';

import type { Agent } from '../../lib/types';
import type { TimelineViewProps } from './types';
import {
  ROLE_LABEL,
  STATUS_LABEL,
  elapsedMs,
  formatDuration,
  sortAgents,
} from './format';

// One row per agent, with a bar from its start to its end (or to `now` while
// running). Positions are percentages of the span from the first start to now.
export default function TimelineView({
  agents,
  onSelect,
  now,
}: TimelineViewProps) {
  if (agents.length === 0) {
    return <p className="views-empty">No agents yet.</p>;
  }

  const sorted = sortAgents(agents);
  const starts = sorted
    .map((a) => a.startedAt)
    .filter((t): t is number => t !== undefined);
  const origin = starts.length > 0 ? Math.min(...starts) : now;
  const end = Math.max(now, origin + 1);
  const span = end - origin;

  return (
    <div className="timeline">
      <div className="timeline__axis">
        <span>{formatDuration(0)}</span>
        <span>{formatDuration(span)}</span>
      </div>
      {sorted.map((agent) => (
        <TimelineRow
          key={agent.id}
          agent={agent}
          origin={origin}
          span={span}
          now={now}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TimelineRow({
  agent,
  origin,
  span,
  now,
  onSelect,
}: {
  agent: Agent;
  origin: number;
  span: number;
  now: number;
  onSelect?: (agent: Agent) => void;
}) {
  const startedAt = agent.startedAt;
  const started = startedAt !== undefined;
  const barEnd = agent.endedAt ?? now;
  const left = started ? ((startedAt - origin) / span) * 100 : 0;
  const width = started
    ? Math.max(((barEnd - startedAt) / span) * 100, 0.5)
    : 0;

  return (
    <div
      className="timeline__row"
      data-agent-id={agent.id}
      data-status={agent.status}
      onClick={onSelect ? () => onSelect(agent) : undefined}
    >
      <div className="timeline__label">
        <span className={`tier-badge tier-badge--${agent.role}`}>
          {ROLE_LABEL[agent.role]}
        </span>
        <span className="timeline__title">{agent.title}</span>
      </div>
      <div className="timeline__track">
        {started && (
          <div
            className={`timeline__bar timeline__bar--${agent.status}`}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${STATUS_LABEL[agent.status]} · ${formatDuration(elapsedMs(agent, now))}`}
          />
        )}
      </div>
    </div>
  );
}
