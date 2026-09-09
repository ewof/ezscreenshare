// Keep capture and playback running on the audio thread, including silence.
class CompatCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(960);
    this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    const frames = channels?.[0]?.length || 128;
    for (let i = 0; i < frames; i++) {
      let value = 0;
      for (const channel of channels || []) value += channel[i] || 0;
      this.samples[this.used++] = channels?.length ? value / channels.length : 0;
      if (this.used === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(960);
        this.used = 0;
      }
    }
    // The output is intentionally silent: never monitor captured audio here.
    return true;
  }
}

class CompatPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.position = 0;
    this.seconds = 0;
    this.started = false;
    this.port.onmessage = ({ data }) => {
      if (data.reset) {
        this.queue = [];
        this.position = this.seconds = 0;
        this.started = false;
        return;
      }
      if (!(data.samples instanceof Int16Array) || !data.samples.length ||
          !Number.isFinite(data.rate) || data.rate < 8000 || data.rate > 192000) return;
      this.queue.push(data);
      this.seconds += data.samples.length / data.rate;
      // A burst after a network stall must not become seconds of stale audio.
      while (this.seconds > 0.2 && this.queue.length > 1) {
        const old = this.queue.shift();
        this.seconds -= (old.samples.length - this.position) / old.rate;
        this.position = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    if (!this.started && this.seconds < 0.04) return true;
    this.started = true;
    for (let i = 0; i < out.length; i++) {
      const packet = this.queue[0];
      if (!packet) {
        this.started = false;
        this.seconds = 0;
        break; // Leave silence, never repeat the last sample or packet.
      }
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const a = packet.samples[index];
      const b = packet.samples[Math.min(index + 1, packet.samples.length - 1)];
      out[i] = (a + (b - a) * fraction) / 32768;
      this.position += packet.rate / sampleRate;
      this.seconds = Math.max(0, this.seconds - 1 / sampleRate);
      if (this.position >= packet.samples.length) {
        this.position -= packet.samples.length;
        this.queue.shift();
        if (!this.queue.length) this.position = 0;
      }
    }
    return true;
  }
}

registerProcessor('compat-capture', CompatCapture);
registerProcessor('compat-playback', CompatPlayback);
