import { appState } from '@/state';

/**
 * Whether this editor tab must not change the project: another tab holds the writer claim
 * (plan D6). Replaces 1.x's `collaboration.isReadOnly`; the banner offers "Take over".
 */
export const isReadOnlyTab = (): boolean => appState.project.host.writer === 'other';
