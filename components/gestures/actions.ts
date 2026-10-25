// Shared gesture action contract. GestureLayer, useGestures and HandCamToggle
// all emit these; ui-shell maps them to view/sidebar/detail/fullscreen state.

export type GestureActionType =
  | 'view-next'
  | 'view-prev'
  | 'refresh'
  | 'toggle-sidebar'
  | 'open-detail'
  | 'toggle-fullscreen';

export const GESTURE_ACTION_TYPES: readonly GestureActionType[] = [
  'view-next',
  'view-prev',
  'refresh',
  'toggle-sidebar',
  'open-detail',
  'toggle-fullscreen',
];

export type GestureAction = {
  type: GestureActionType;
  // Only set for 'open-detail' (long-press on [data-agent-id]).
  agentId?: string;
};

export type GestureActionHandler = (action: GestureAction) => void;
