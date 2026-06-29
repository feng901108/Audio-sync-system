import { open, statSync } from "node:fs";
import { promisify } from "node:util";
import { read as readCb, close as closeCb } from "node:fs";
import { extname } from "node:path";

const openAsync = promisify(open);
const readAsync = promisify(readCb);
const closeAsync = promisify(closeCb);

// 探测音频时长：MP3 扫帧头累加，WAV 读 RIFF data/byteRate。其他格式返回 0
// （scheduler 在 duration<=0 时不自动切歌，故白噪音尽量用 MP3/WAV；FLAC/M4A 等返回 0 需手动切）。
export async function probeAudioDuration(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp3") return await probeMp3(filePath);
  if (ext === ".wav") return await probeWav(filePath);
  return 0;
}

// WAV：RIFF/WAVE 容器，扫 fmt chunk 拿 byteRate、data chunk 拿字节数，duration = dataSize / byteRate
async function probeWav(filePath) {
  const fd = await openAsync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    const buf = Buffer.alloc(Math.min(64 * 1024, size));
    await readAsync(fd, buf, 0, buf.length, 0);
    if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WAVE") return 0;
    let byteRate = 0, dataSize = 0;
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.subarray(off, off + 4).toString("ascii");
      const sz = buf.readUInt32LE(off + 4);
      if (id === "fmt ") {
        byteRate = buf.readUInt32LE(off + 16); // fmt chunk: 8 字节头 + audioFormat(2)+channels(2)+sampleRate(4) = 偏移 16 处是 byteRate
      } else if (id === "data") {
        dataSize = sz;
        break;
      }
      off += 8 + sz + (sz % 2); // chunk 数据偶数对齐
    }
    if (!byteRate || !dataSize) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } finally {
    await closeAsync(fd);
  }
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000, 0], // MPEG 1
  2: [22050, 24000, 16000, 0], // MPEG 2
  0: [11025, 12000, 8000, 0],  // MPEG 2.5
};

async function probeMp3(filePath) {
  const fd = await openAsync(filePath, "r");
  try {
    const stat = statSync(filePath);
    const size = stat.size;
    const headBuf = Buffer.alloc(10);
    await readAsync(fd, headBuf, 0, 10, 0);
    let offset = 0;
    if (headBuf.subarray(0, 3).toString("ascii") === "ID3") {
      const sz = ((headBuf[6] & 0x7f) << 21) | ((headBuf[7] & 0x7f) << 14) | ((headBuf[8] & 0x7f) << 7) | (headBuf[9] & 0x7f);
      offset = 10 + sz;
    }

    const sample = Buffer.alloc(Math.min(64 * 1024, size - offset));
    if (sample.length < 4) return 0;
    await readAsync(fd, sample, 0, sample.length, offset);
    const frame = findFrame(sample);
    if (!frame) return 0;

    // 用首帧 bitrate 推算总时长（CBR 场景准确，VBR 场景近似）
    const audioBytes = size - offset;
    const totalSec = (audioBytes * 8) / (frame.bitrate * 1000);
    return Math.round(totalSec * 1000);
  } finally {
    await closeAsync(fd);
  }
}

function findFrame(buf) {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    if ((buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versionId = (buf[i + 1] >> 3) & 0x03;
    const layer = (buf[i + 1] >> 1) & 0x03;
    if (layer !== 1) continue; // 只处理 Layer III
    const bitIdx = (buf[i + 2] >> 4) & 0x0f;
    const sampleIdx = (buf[i + 2] >> 2) & 0x03;
    const table = versionId === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3;
    const bitrate = table[bitIdx];
    const sampleRate = SAMPLE_RATES[versionId]?.[sampleIdx];
    if (!bitrate || !sampleRate) continue;
    return { bitrate, sampleRate };
  }
  return null;
}
