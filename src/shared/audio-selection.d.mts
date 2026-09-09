export type AudioSelection = { mode: 'include' | 'exclude'; apps: string[] };
export function normalizeAudioSelection(value: unknown): AudioSelection;
export function includesAudioApp(selection: AudioSelection, app: string): boolean;
export function audioSelectionLabel(selection: AudioSelection): string;
