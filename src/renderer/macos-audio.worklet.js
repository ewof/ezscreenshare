// Native input is interleaved stereo Float32 at 48 kHz. Keep a bounded queue
// so a stalled renderer cannot introduce a growing delay into the live stream.
class MacAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.position = 0;
    this.frames = 0;
    this.port.onmessage = ({ data }) => {
      if (!(data instanceof Float32Array) || !data.length || data.length % 2) return;
      this.queue.push(data);
      this.frames += data.length / 2;
      while (this.frames > 9600 && this.queue.length > 1) {
        this.frames -= this.queue.shift().length / 2 - this.position;
        this.position = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const channels = outputs[0];
    for (const channel of channels) channel.fill(0);
    for (let i = 0; i < channels[0].length; i++) {
      const packet = this.queue[0];
      if (!packet) break;
      const frame = Math.floor(this.position);
      for (let channel = 0; channel < channels.length; channel++) {
        channels[channel][i] = packet[frame * 2 + Math.min(channel, 1)];
      }
      const step = 48000 / sampleRate;
      this.position += step;
      this.frames = Math.max(0, this.frames - step);
      if (this.position >= packet.length / 2) {
        this.position -= packet.length / 2;
        this.queue.shift();
        if (!this.queue.length) this.position = 0;
      }
    }
    return true;
  }
}
registerProcessor('macos-audio', MacAudio);
