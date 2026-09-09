import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { normalizeAudioSelection, audioSelectionLabel } from '../shared/audio-selection.mjs';

export class MacAudio {
  constructor(binary) { this.binary = binary; this.active = null; this.sequence = 0; this.labels = new Map(); this.children = new Set(); }

  launch(argument, onMessage, onExit) {
    const child = spawn(this.binary, [argument], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    let error = '';
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { onMessage(JSON.parse(line)); }
      catch (err) { onMessage({ error: `Invalid native audio response: ${err.message}` }); }
    });
    child.once('error', err => onExit(err));
    child.once('exit', code => { lines.close(); onExit(new Error(error || `macOS audio helper stopped (${code}).`)); });
    return child;
  }

  async list() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('macOS audio source discovery timed out. Check Screen & System Audio Recording permission.')); }, 30000);
      const child = this.launch('list', message => {
        if (message.error) { clearTimeout(timer); child.kill(); reject(new Error(message.error)); }
        if (message.sources) {
          clearTimeout(timer);
          this.labels = new Map(message.sources.map(source => [source.id.slice(4), source.label]));
          resolve(message.sources);
        }
      }, error => { clearTimeout(timer); reject(error); });
    });
  }

  stop() {
    const active = this.active;
    this.active = null;
    if (active) { active.child.stdin.end(); active.child.kill(); }
  }

  dispose() {
    this.stop();
    for (const child of this.children) {
      child.stdin.end();
      child.kill();
    }
    this.children.clear();
  }

  async start(selection, sender) {
    this.stop();
    const wanted = normalizeAudioSelection(selection);
    if (wanted.mode === 'include' && !wanted.apps.length) return { ok: false };
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = error => {
        clearTimeout(timer);
        if (this.active?.id !== id) { reject(error); return; }
        this.stop();
        if (ready && !sender.isDestroyed()) sender.send('ez:macAudioError', { id, error: error.message });
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('macOS audio capture timed out. Check Screen & System Audio Recording permission.')), 30000);
      const child = this.launch(JSON.stringify(wanted), message => {
        if (this.active?.id !== id) return;
        if (message.error) return fail(new Error(message.error));
        if (message.ready) {
          ready = true;
          clearTimeout(timer);
          resolve({ ok: true, id, label: audioSelectionLabel({ ...wanted, apps: wanted.apps.map(app => this.labels.get(app) || app) }) });
        }
        if (ready && message.pcm && !sender.isDestroyed()) {
          const bytes = Buffer.from(message.pcm, 'base64');
          if (bytes.length && bytes.length <= 384000 && bytes.length % 8 === 0) sender.send('ez:macAudioData', { id, bytes });
        }
      }, fail);
      this.active = { id, child };
    });
  }
}
