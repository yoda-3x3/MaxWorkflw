// Props contract for the run views. Agent comes from the shared lib/types.ts.

import type { Agent } from '../../lib/types';

export type { Agent, AgentStatus, AgentRole, Tier } from '../../lib/types';

export interface AgentViewProps {
  agents: Agent[];
  /** Called when a card, node or bar is clicked. */
  onSelect?: (agent: Agent) => void;
  /** Current time in ms. Omit to let the view tick itself once a second. */
  now?: number;
}

export interface TimelineViewProps extends AgentViewProps {
  /** Current time in ms, refreshed by the parent so running bars grow. */
  now: number;
}
