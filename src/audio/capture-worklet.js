// マイク入力を hopSize サンプルずつまとめてメインスレッドへ送る AudioWorkletProcessor。
// 各ブロックに先頭サンプルのフレーム番号（AudioContext 上の時刻）を付ける。

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.hopSize = options?.processorOptions?.hopSize ?? 1024;
    this.buffer = new Float32Array(this.hopSize);
    this.pos = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (this.pos === 0) this.startFrame = currentFrame + i;
      this.buffer[this.pos++] = channel[i];
      if (this.pos === this.hopSize) {
        this.port.postMessage({ frame: this.startFrame, samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.hopSize);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
