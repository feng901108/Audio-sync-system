// Phase B 验证：v4 client (supportsSyncTicks:true) 收到 sync，v3 client (无) 不收到
const runOne = (label, supportsSyncTicks) => new Promise((resolve) => {
  const ws = new WebSocket("ws://localhost:3000/ws");
  const startAt = Date.now();
  let syncCount = 0;
  let playCount = 0;
  let hello = null;
  let lastTickAt = 0;
  const deltas = [];

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "register",
      deviceId: `${label}-client`,
      name: label,
      kind: "web",
      zoneId: 1,
      ...(supportsSyncTicks ? { supportsSyncTicks: true } : {}),
    }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "sync") {
      syncCount++;
      const now = Date.now();
      if (lastTickAt > 0) deltas.push(now - lastTickAt);
      lastTickAt = now;
    } else if (msg.type === "play") playCount++;
    else if (msg.type === "hello") hello = msg;
  };

  setTimeout(() => {
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    console.log(`[${label}] supportsSyncTicks=${!!supportsSyncTicks}`);
    console.log(`  hello=${hello?.deviceId} play=${playCount} sync=${syncCount}`);
    console.log(`  avg sync interval: ${avg.toFixed(1)}ms (samples=${deltas.length})`);
    ws.close();
    resolve({ label, syncCount, playCount, avg });
  }, 3000);
});

const results = await Promise.all([runOne("v4", true), runOne("v3", false)]);
console.log("\n=== summary ===");
const v4 = results[0], v3 = results[1];
if (v4.syncCount >= 12 && v3.syncCount === 0) {
  console.log(`✓ v4 client got ${v4.syncCount} sync ticks, v3 client got 0 (correct)`);
  console.log(`✓ avg interval ${v4.avg.toFixed(1)}ms (expect ~200ms ±25ms)`);
  process.exit(0);
} else {
  console.log(`✗ FAIL: v4.syncCount=${v4.syncCount} (expect >=12), v3.syncCount=${v3.syncCount} (expect 0)`);
  process.exit(1);
}