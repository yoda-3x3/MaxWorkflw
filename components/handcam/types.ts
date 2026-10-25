// Shared gesture action contract lives in components/gestures/actions.ts.
// Type-only import: erased at runtime, so tests do not need that module on disk.
import type { GestureAction, GestureActionHandler } from '../gestures/actions';

export type { GestureAction, GestureActionHandler };
