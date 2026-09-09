import macAudioUrl from "./macos-audio.worklet.js?url&no-inline";
import type { AudioSelection } from "../shared/audio-selection.mjs";

let cleanupActive: (() => void) | undefined;
let generation = 0;
export function stopMacAudio(): void { cleanupActive?.(); }
export async function startMacAudio(stream: MediaStream, wanted: AudioSelection, onError: (error: string) => void): Promise<string> {
  stopMacAudio();
  const currentGeneration = ++generation;
  const bridge = window.ez;
  const windows = bridge?.platform === "win32";
  const begin = windows ? bridge?.beginWindowsAudio : bridge?.beginMacAudio;
  const subscribe = windows ? bridge?.onWindowsAudio : bridge?.onMacAudio;
  if (!begin || !subscribe) throw new Error("Restart the updated desktop app to enable application audio.");
  const context = new AudioContext({ sampleRate: 48000 });
  let unsubscribe: (() => void) | undefined;
  let node: AudioWorkletNode | undefined;
  let track: MediaStreamTrack | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe?.();
    node?.disconnect();
    track?.stop();
    void context.close();
    if (cleanupActive === cleanup) cleanupActive = undefined;
  };
  cleanupActive = cleanup;
  try {
    await context.audioWorklet.addModule(macAudioUrl);
    if (cleaned) throw new Error("Audio capture was stopped.");
    node = new AudioWorkletNode(context, "macos-audio", { outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);
    await context.resume();
    if (cleaned) throw new Error("Audio capture was stopped.");
    let sessionId = -1;
    unsubscribe = subscribe(packet => {
      if (packet.id !== sessionId || cleaned) return;
      if (packet.error) {
        console.error("[ezscreenshare]", packet.error);
        onError(packet.error);
        cleanup();
        return;
      }
      if (packet.bytes) {
        const bytes = new Uint8Array(packet.bytes);
        const samples = new Float32Array(bytes.buffer);
        node!.port.postMessage(samples, [samples.buffer]);
      }
    });
    const session = await begin(wanted);
    if (cleaned) throw new Error("Audio capture was stopped.");
    if (!session.ok) throw new Error("Native audio capture did not start.");
    sessionId = session.id;
    track = destination.stream.getAudioTracks()[0];
    track.contentHint = "music";
    stream.addTrack(track);
    return session.label;
  } catch (error) {
    cleanup();
    if (currentGeneration === generation) await bridge?.releaseAudioTap();
    throw error;
  }
}

