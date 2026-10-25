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
  sortAgents,
} from './format';

// Orchestrator -> Leads -> Workers, drawn from parentId links. An agent whose
// parent is missing from the list is shown at the top level, not dropped.
export default function TreeView({ agents, onSelect, now }: AgentViewProps) {
  const tick = useNow(now === undefined);
  const current = now ?? tick;

  if (agents.length === 0) {
    return <p className="views-empty">No agents yet.</p>;
  }

  const ids = new Set(agents.map((a) => a.id));
  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of sortAgents(agents)) {
    if (agent.parentId && ids.has(agent.parentId)) {
      const list = childrenOf.get(agent.parentId) ?? [];
      list.push(agent);
      childrenOf.set(agent.parentId, list);
    } else {
      roots.push(agent);
    }
  }

  return (
    <ul className="tree tree--root">
      {roots.map((agent) => (
        <TreeNode
          key={agent.id}
          agent={agent}
          childrenOf={childrenOf}
          now={current}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  agent,
  childrenOf,
  now,
  onSelect,
}: {
  agent: Agent;
  childrenOf: Map<string, Agent[]>;
  now: number;
  onSelect?: (agent: Agent) => void;
}) {
  const kids = childrenOf.get(agent.id) ?? [];

  const handleKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(agent);
    }
  };

  return (
    <li className="tree__item" data-agent-id={agent.id} data-tier={agent.tier}>
      <div
        className={`tree__node tree__node--${agent.status}`}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect ? () => onSelect(agent) : undefined}
        onKeyDown={onSelect ? handleKey : undefined}
      >
        <span className={`tier-badge tier-badge--${agent.role}`}>
          {ROLE_LABEL[agent.role]}
        </span>
        <span className="tree__title">{agent.title}</span>
        <span className={`status-pill status-pill--${agent.status}`}>
          {STATUS_LABEL[agent.status]}
        </span>
        <span className="tree__timer">
          {formatDuration(elapsedMs(agent, now))}
        </span>
      </div>
      {kids.length > 0 && (
        <ul className="tree">
          {kids.map((kid) => (
            <TreeNode
              key={kid.id}
              agent={kid}
              childrenOf={childrenOf}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
