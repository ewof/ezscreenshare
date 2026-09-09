export function normalizeAudioSelection(value) {
  if (typeof value === 'string') {
    if (value.startsWith('app:')) return { mode: 'include', apps: [value.slice(4)] };
    return { mode: value === 'none' ? 'include' : 'exclude', apps: [] };
  }
  return {
    mode: value?.mode === 'include' ? 'include' : 'exclude',
    apps: [...new Set((Array.isArray(value?.apps) ? value.apps : [])
      .filter(x => typeof x === 'string' && x.length > 0 && x.length <= 256))].slice(0, 128).sort(),
  };
}

export function includesAudioApp(selection, app) {
  return selection.mode === 'include' ? selection.apps.includes(app) : !selection.apps.includes(app);
}

export function audioSelectionLabel(selection) {
  if (selection.mode === 'exclude') {
    return selection.apps.length ? `Everything except ${selection.apps.join(', ')}` : 'Entire system';
  }
  return selection.apps.length ? selection.apps.join(', ') : 'No audio';
}
