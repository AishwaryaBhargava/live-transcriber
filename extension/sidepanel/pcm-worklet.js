// extension/sidepanel/pcm-worklet.js
// Sends 100 ms mono Int16 PCM (48kHz) frames to the page via port.postMessage

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = 4800; // 100 ms @ 48kHz
    this.buf = new Float32Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0];
    const ch1 = input[1];

    for (let i = 0; i < ch0.length; i++) {
      // Downmix to mono if stereo
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.buf[this.offset++] = s;

      if (this.offset >= this.frameSamples) {
        // Float32 [-1,1] -> Int16LE
        const pcm = new Int16Array(this.frameSamples);
        for (let j = 0; j < this.frameSamples; j++) {
          let v = this.buf[j];
          if (v > 1) v = 1;
          else if (v < -1) v = -1;
          pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        // Transfer the underlying buffer (zero-copy)
        this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
