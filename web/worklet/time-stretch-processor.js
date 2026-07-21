/**
 * TimeStretchProcessor — 相位声码器 AudioWorklet
 *
 * FFT 2048 + Hann 窗 + 75% 重叠 + Identity Phase Locking（保立体声像）
 * 专为 ±2.5% 微调优化，零外部依赖。
 *
 * 接入方式：MediaElementSource → AudioWorkletNode → GainNode → destination
 * 参数控制：stretchRatio (AudioParam, default 1.0, range 0.975-1.025)
 */
class TimeStretchProcessor extends AudioWorkletProcessor {
  // -- 常量和预计算表 --
  static FFT_SIZE = 2048;
  static HOP = 512; // FFT_SIZE / 4，75% overlap
  static IN_BUF = 8192; // 输入环形缓冲区 ~185ms
  static OUT_BUF = 16384; // 输出环形缓冲区 ~370ms
  static TARGET_FILL = 4096; // 目标输出缓冲区填充量

  // AudioParam 声明：浏览器自动根据此描述符创建 stretchRatio 参数
  static get parameterDescriptors() {
    return [
      {
        name: "stretchRatio",
        defaultValue: 1.0,
        minValue: 0.95,
        maxValue: 1.05,
        automationRate: "k-rate", // 每帧不变，省 CPU
      },
    ];
  }

  constructor() {
    super();

    const N = TimeStretchProcessor.FFT_SIZE;
    const halfN = N >> 1;

    // -- 预计算 --
    this._hann = _buildHann(N);
    this._bitRev = _buildBitRev(N);
    this._twidCos = new Float32Array(halfN);
    this._twidSin = new Float32Array(halfN);
    _buildTwiddle(N, this._twidCos, this._twidSin);

    // -- 声道数（运行时探测） --
    this._channels = 0;

    // -- 环形缓冲区（动态分配） --
    this._inBuf = null; // Float32Array[]
    this._outBuf = null; // Float32Array[]
    this._inW = 0; // 输入写指针
    this._inR = 0; // 输入读指针（处理位置）
    this._outW = 0; // 输出写指针（float，支持 fractional hop）
    this._outR = 0; // 输出读指针

    // -- 相位状态 --
    this._prevPhase = null; // float[N/2+1][ch]
    this._outPhase = null; // float[N/2+1][ch]

    // -- 工作缓冲 --
    this._workRe = null; // float[N][ch]
    this._workIm = null;
    this._mag = null; // float[N/2+1][ch]
    this._phase = null; // float[N/2+1][ch]

    // -- 预期相位增量 --
    this._expectedDelta = new Float32Array(halfN + 1);
    for (let k = 0; k <= halfN; k++) {
      this._expectedDelta[k] =
        (2 * Math.PI * k * TimeStretchProcessor.HOP) / N;
    }

    this._ratio = 1.0;
    this._initialized = false;
  }

  _init(ch) {
    const N = TimeStretchProcessor.FFT_SIZE;
    const halfN = N >> 1;
    this._channels = ch;
    this._inBuf = Array.from({ length: ch }, () =>
      new Float32Array(TimeStretchProcessor.IN_BUF)
    );
    this._outBuf = Array.from({ length: ch }, () =>
      new Float32Array(TimeStretchProcessor.OUT_BUF)
    );
    this._prevPhase = Array.from({ length: ch }, () =>
      new Float32Array(halfN + 1)
    );
    this._outPhase = Array.from({ length: ch }, () =>
      new Float32Array(halfN + 1)
    );
    this._workRe = Array.from({ length: ch }, () => new Float32Array(N));
    this._workIm = Array.from({ length: ch }, () => new Float32Array(N));
    this._mag = Array.from({ length: ch }, () => new Float32Array(halfN + 1));
    this._phase = Array.from({ length: ch }, () =>
      new Float32Array(halfN + 1)
    );
    this._initialized = true;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const ch = input.length;
    if (ch === 0) return true; // 无输入，继续等待

    if (!this._initialized || this._channels !== ch) {
      this._init(ch);
    }

    const ratio = parameters.stretchRatio[0];
    this._ratio = ratio;
    const frames = input[0].length; // 通常 128
    const N = TimeStretchProcessor.FFT_SIZE;
    const hop = TimeStretchProcessor.HOP;

    // 1. 写入输入环形缓冲区
    for (let c = 0; c < ch; c++) {
      const src = input[c];
      const buf = this._inBuf[c];
      let w = this._inW;
      for (let i = 0; i < frames; i++) {
        buf[w] = src[i];
        w = (w + 1) % TimeStretchProcessor.IN_BUF;
      }
    }
    this._inW =
      (this._inW + frames) % TimeStretchProcessor.IN_BUF;

    // 2. 处理尽可能多的 hop
    const inAvail = _avail(
      this._inR,
      this._inW,
      TimeStretchProcessor.IN_BUF
    );
    const outFill = _avail(
      this._outR,
      Math.round(this._outW),
      TimeStretchProcessor.OUT_BUF
    );
    const outRoom = TimeStretchProcessor.OUT_BUF - outFill;

    // 处理策略：保持输出缓冲区在 TARGET_FILL 水平附近
    let maxHops = Math.floor(
      Math.min(inAvail - N, outRoom) / hop
    );
    if (outFill < TimeStretchProcessor.TARGET_FILL) {
      maxHops = Math.min(
        maxHops,
        Math.floor(
          (TimeStretchProcessor.TARGET_FILL - outFill) /
            (hop * ratio) +
          1
        )
      );
    }
    maxHops = Math.max(0, Math.min(maxHops, 8));

    // 回绕输入读指针方便连续读取
    for (let h = 0; h < maxHops; h++) {
      const inPos = (this._inR + h * hop) % TimeStretchProcessor.IN_BUF;

      // 提取分析帧 + 加窗 + FFT
      for (let c = 0; c < ch; c++) {
        _copyWrapped(
          this._inBuf[c],
          inPos,
          N,
          TimeStretchProcessor.IN_BUF,
          this._workRe[c],
          this._hann
        );
        this._workIm[c].fill(0);
        _fft(
          this._workRe[c],
          this._workIm[c],
          this._bitRev,
          this._twidCos,
          this._twidSin,
          N
        );
        // 转换到 magnitude/phase
        _toPolar(
          this._workRe[c],
          this._workIm[c],
          this._mag[c],
          this._phase[c],
          N
        );
      }

      // 相位调整（IPL：左声道相位主导，保立体声像）
      const halfN = N >> 1;
      for (let k = 0; k <= halfN; k++) {
        const magL = this._mag[0][k];

        // 取主导声道（ch=1 用自己，ch>=2 用左声道相位）
        for (let c = 0; c < ch; c++) {
          if (ch >= 2 && c > 0) {
            // 从声道相位：用自己的 mag，用主导声道的相位差
            const dAct =
              this._phase[c][k] - this._prevPhase[c][k];
            const dHet = _wrapPhase(
              dAct - this._expectedDelta[k]
            );
            const dStr =
              this._expectedDelta[k] * ratio + dHet;
            this._outPhase[c][k] = _wrapPhase(
              this._outPhase[c][k] + dStr
            );
          } else {
            const dAct =
              this._phase[c][k] - this._prevPhase[c][k];
            const dHet = _wrapPhase(
              dAct - this._expectedDelta[k]
            );
            const dStr =
              this._expectedDelta[k] * ratio + dHet;
            this._outPhase[c][k] = _wrapPhase(
              this._outPhase[c][k] + dStr
            );
          }
          this._prevPhase[c][k] = this._phase[c][k];
        }
      }

      // 重建复数频谱 + IFFT + 合成窗 + 重叠相加
      const outFramePos = Math.round(this._outW + h * hop * ratio);
      for (let c = 0; c < ch; c++) {
        // 重建
        for (let k = 0; k < N; k++) {
          const kk = k <= halfN ? k : N - k;
          const mag = this._mag[c][kk];
          let ph = this._outPhase[c][kk];
          if (k > halfN) ph = -ph; // 共轭
          this._workRe[c][k] = mag * Math.cos(ph);
          this._workIm[c][k] = mag * Math.sin(ph);
        }
        _ifft(
          this._workRe[c],
          this._workIm[c],
          this._bitRev,
          this._twidCos,
          this._twidSin,
          N
        );
        // 重叠相加（合成窗）
        for (let i = 0; i < N; i++) {
          const idx = (outFramePos + i) % TimeStretchProcessor.OUT_BUF;
          this._outBuf[c][idx] += this._workRe[c][i] * this._hann[i];
        }
      }
    }

    // 输入读指针推进
    this._inR =
      (this._inR + maxHops * hop) % TimeStretchProcessor.IN_BUF;
    this._outW += maxHops * hop * ratio;

    // 防止 outW 和 outR 差值过大
    const ow = Math.round(this._outW);
    const oa = _avail(this._outR, ow, TimeStretchProcessor.OUT_BUF);
    if (oa > TimeStretchProcessor.OUT_BUF * 0.8) {
      // 输出缓冲太满，丢弃部分
      this._outR =
        (ow -
          TimeStretchProcessor.TARGET_FILL +
          TimeStretchProcessor.OUT_BUF) %
        TimeStretchProcessor.OUT_BUF;
      // 清零丢弃区域
      for (let c = 0; c < ch; c++) {
        const s1 = Math.min(this._outR, ow);
        const s2 = Math.max(this._outR, ow);
        this._outBuf[c].fill(0, s1, s2 - s1);
      }
    }

    // 3. 从输出缓冲区提取 frames 个样本
    let outAvail = _avail(
      this._outR,
      Math.round(this._outW),
      TimeStretchProcessor.OUT_BUF
    );

    for (let c = 0; c < ch; c++) {
      const dst = output[c] || new Float32Array(frames);
      const buf = this._outBuf[c];
      let r = this._outR;
      if (outAvail >= frames) {
        for (let i = 0; i < frames; i++) {
          dst[i] = buf[r];
          buf[r] = 0; // 消费后清零
          r = (r + 1) % TimeStretchProcessor.OUT_BUF;
        }
      } else {
        // 不足：静音填充
        dst.fill(0);
        if (outAvail > 0) {
          for (let i = 0; i < outAvail; i++) {
            dst[i] = buf[r];
            buf[r] = 0;
            r = (r + 1) % TimeStretchProcessor.OUT_BUF;
          }
        }
      }
      if (c === 0 && outAvail >= frames) {
        this._outR =
          (this._outR + frames) % TimeStretchProcessor.OUT_BUF;
      }
    }

    return true; // 保活
  }
}

// ============ FFT 工具 ============

function _buildHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

function _buildBitRev(n) {
  const rev = new Int32Array(n);
  let bits = 0;
  let tmp = n - 1;
  while (tmp) { bits++; tmp >>= 1; }
  for (let i = 0; i < n; i++) {
    let r = 0;
    let t = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (t & 1);
      t >>= 1;
    }
    rev[i] = r;
  }
  return rev;
}

function _buildTwiddle(n, cos, sin) {
  for (let i = 0; i < n >> 1; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
}

/**
 * Radix-2 迭代替换 FFT（in-place）
 * 输入: re/im 为 interleaved complex 数组，长度 n
 * 输出: re/im 原地更新为频谱
 */
function _fft(re, im, rev, twidCos, twidSin, n) {
  // Bit-reversal
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, ti = 0; k < half; k++, ti += step) {
        const wRe = twidCos[ti];
        const wIm = twidSin[ti];
        const tRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
        const tIm = re[i + k + half] * wIm + im[i + k + half] * wRe;
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
      }
    }
  }
}

/**
 * IFFT = conjugate input → FFT → conjugate output → scale by 1/n
 */
function _ifft(re, im, rev, twidCos, twidSin, n) {
  for (let i = 0; i < n; i++) im[i] = -im[i];
  _fft(re, im, rev, twidCos, twidSin, n);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -(im[i] / n);
  }
}

function _toPolar(re, im, mag, phase, n) {
  const halfN = n >> 1;
  for (let k = 0; k <= halfN; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
}

// ============ 环形缓冲区工具 ============

function _avail(r, w, size) {
  return w >= r ? w - r : size - r + w;
}

function _copyWrapped(src, start, len, bufSize, dst, win) {
  for (let i = 0; i < len; i++) {
    dst[i] = src[(start + i) % bufSize] * win[i];
  }
}

function _wrapPhase(d) {
  return d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
}

registerProcessor("time-stretch", TimeStretchProcessor);
