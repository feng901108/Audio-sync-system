// Phase C 验证：JUGUANG_SYNC_V4_ENABLED env kill switch
// 期望：env=0 时 client 收不到任何 sync（fallback v3 公式）
const runOne = () => new Promise((resolve) => {
  const ws = new WebSocket("ws://localhost:3000/ws");
  let syncCount = 0;
  let playCount = 0;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "register",
      deviceId: "killswitch-client",
      name: "killSwitch",
      kind: "web",
      zoneId: 1,
      supportsSyncTicks: true,
    }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "sync") syncCount++;
    else if (msg.type === "play") playCount++;
  };
  setTimeout(() => {
    ws.close();
    resolve({ syncCount, playCount });
  }, 3000);
});

const r = await runOne();
console.log(`sync=${r.syncCount} play=${r.playCount}`);
if (r.syncCount === 0 && r.playCount === 1) {
  console.log("✓ KILL SWITCH WORKS: sync disabled, play still works");
  process.exit(0);
} else if (r.syncCount > 0) {
  console.log(`✗ FAIL: expected 0 sync, got ${r.syncCount}`);
  process.exit(1);
} else {
  console.log(`✗ FAIL: play=${r.playCount} (expect 1)`);
  process.exit(1);
}