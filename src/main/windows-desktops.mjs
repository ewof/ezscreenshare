import { execFile } from 'node:child_process';

export function readWindowsDesktops(binary) {
  return new Promise((resolve, reject) => {
    execFile(binary, [], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        if (error || result.error) throw new Error(result.error || error.message);
        resolve(result);
      } catch (failure) { reject(failure); }
    });
  });
}

export function mergeDesktopSources(electronSources, catalog) {
  const windows = new Map(catalog.sources.map(source => [source.id, source]));
  const result = electronSources.map(source => ({
    ...windows.get(source.id),
    id: source.id, name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.toDataURL(),
  }));
  const seen = new Set(result.map(source => source.id));
  for (const source of catalog.sources) {
    if (!seen.has(source.id)) result.push({ ...source, thumbnail: '' });
  }
  return { sources: result, desktops: catalog.desktops };
}
