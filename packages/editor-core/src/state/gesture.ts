import { appState } from '@/state';

/**
 * `appState.ui.gestureInProgress`: a pointer gesture that commits coalesced operations on every
 * move is running (a viewport drag, a timeline keyframe drag, an inspector scrub). The idle flush
 * waits for it to end (`FlushService`, plan §C.1), so a file is never written mid-gesture.
 * Session UI state: written directly by the gesture's owner.
 */
export const setGestureInProgress = (active: boolean): void => {
  if (appState.ui.gestureInProgress !== active) appState.ui.gestureInProgress = active;
};
