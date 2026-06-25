import { open, statSync } from "node:fs";
import { promisify } from "node:util";
import { read as readCb, close as closeCb } from "node:fs";
import { extname } from "node:path";

const openAsync = promisify(open);
const readAsync = promisify(readCb);
const closeAsync = promisify(closeCb);

// 仅探测 MP3：扫描所有 frame header 累加时长。其他格式返回 0，前端会用音频元素 metadata 兜底。
export async function probeAudioDuration(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp3") return await probeMp3(filePath);
  return 0;
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
