// Phase E 验证：play 消息不再含 startServerTime，但客户端能正常起播（靠 immediate sync tick 拿位置）
const ws = new WebSocket("ws://localhost:3000/ws");
let playMsg = null;
let syncAfterPlay = null;
let order = [];

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "phase-e-client",
    name: "PhaseE",
    kind: "web",
    zoneId: 1,
    supportsSyncTicks: true,
  }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  order.push(msg.type);
  if (msg.type === "play") {
    playMsg = msg;
    console.log("[play message keys]:", Object.keys(msg).sort().join(", "));
    console.log("[play] startServerTime in msg:", "startServerTime" in msg);
  }
  if (msg.type === "sync" && !syncAfterPlay) {
    syncAfterPlay = msg;
    console.log("[first sync after register]:", JSON.stringify(syncAfterPlay).slice(0, 200));
  }
};

setTimeout(() => {
  console.log("\n[order]", order.join(" → "));
  if (playMsg && "startServerTime" in playMsg) {
    console.log("✗ FAIL: play msg still has startServerTime");
    process.exit(1);
  }
  if (!playMsg) {
    console.log("✗ FAIL: no play msg received");
    process.exit(1);
  }
  if (!syncAfterPlay) {
    console.log("✗ FAIL: no sync tick received");
    process.exit(1);
  }
  if (order.indexOf("sync") > order.indexOf("play") + 1) {
    console.log("✗ FAIL: sync not immediately after play");
    process.exit(1);
  }
  console.log("✓ Phase E OK: play msg has no startServerTime, sync tick immediately follows");
  ws.close();
  process.exit(0);
}, 2000);