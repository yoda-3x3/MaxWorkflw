'use client';

import type { KeyboardEvent } from 'react';
import type { Agent } from '../../lib/types';
import type { AgentViewProps } from './types';
import { useNow } from './useNow';
import {
  ROLE_LABEL,
  STATUS_LABEL,
  elapsedMs,
  formatDuration,
  formatTokens,
  isActive,
  reportSnippet,
  sortAgents,
} from './format';

// Live grid of agent cards. Running agents glow.
export default function WallView({ agents, onSelect, now }: AgentViewProps) {
  const tick = useNow(now === undefined);
  const current = now ?? tick;
  const sorted = sortAgents(agents);

  if (sorted.length === 0) {
    return <p className="views-empty">No agents yet.</p>;
  }

  return (
    <div className="wall">
      {sorted.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          now={current}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  now,
  onSelect,
}: {
  agent: Agent;
  now: number;
  onSelect?: (agent: Agent) => void;
}) {
  const snippet = reportSnippet(agent.report);
  const active = isActive(agent.status);

  const handleKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(agent);
    }
  };

  return (
    <article
      className={`agent-card agent-card--${agent.status}${active ? ' agent-card--glow' : ''}`}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-tier={agent.tier}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(agent) : undefined}
      onKeyDown={onSelect ? handleKey : undefined}
    >
      <header className="agent-card__head">
        <span className={`tier-badge tier-badge--${agent.role}`}>
          {ROLE_LABEL[agent.role]}
        </span>
        <span className={`status-pill status-pill--${agent.status}`}>
          {STATUS_LABEL[agent.status]}
        </span>
      </header>
      <h3 className="agent-card__title">{agent.title}</h3>
      <dl className="agent-card__meta">
        <div>
          <dt>Model</dt>
          <dd>{agent.model}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd className="agent-card__timer">
            {formatDuration(elapsedMs(agent, now))}
          </dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatTokens(agent.tokens)}</dd>
        </div>
      </dl>
      {snippet ? (
        <p className="agent-card__report">{snippet}</p>
      ) : agent.error ? (
        <p className="agent-card__report agent-card__report--error">
          {agent.error}
        </p>
      ) : null}
    </article>
  );
}
