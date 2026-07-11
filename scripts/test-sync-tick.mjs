// Phase A 验证脚本：连 /ws，注册 zone=1，监听 type:"sync" 消息
// 期望：每 ~200ms 一条 sync 消息，positionMs 单调递增
const ws = new WebSocket("ws://localhost:3000/ws");
const startAt = Date.now();
let count = 0;
let lastPos = -1;
let firstPlay = null;
const syncTimes = [];

ws.onopen = () => {
  console.log("[open] sending register");
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "test-sync-client",
    name: "SyncTest",
    kind: "web",
    zoneId: 1,
  }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "sync") {
    count++;
    syncTimes.push(Date.now());
    if (count <= 3 || count % 10 === 0) {
      console.log(`[sync #${count}] t+${Date.now()-startAt}ms pos=${msg.positionMs} playing=${msg.isPlaying}`);
    }
    if (msg.positionMs < lastPos && lastPos !== -1) {
      console.log(`!!! NON-MONOTONIC: ${lastPos} -> ${msg.positionMs}`);
    }
    lastPos = msg.positionMs;
  } else if (msg.type === "play") {
    console.log(`[play] startServerTime=${msg.startServerTime} trackOffsetMs=${msg.trackOffsetMs}`);
    firstPlay = msg;
  } else if (msg.type === "hello") {
    console.log(`[hello] deviceId=${msg.deviceId} zoneId=${msg.zoneId}`);
  }
};

ws.onerror = (e) => console.error("[err]", e.message ?? e);

setTimeout(() => {
  console.log(`\n[summary] received ${count} sync messages in ${Date.now()-startAt}ms`);
  if (syncTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < syncTimes.length; i++) intervals.push(syncTimes[i] - syncTimes[i-1]);
    const avg = intervals.reduce((a,b) => a+b, 0) / intervals.length;
    const min = Math.min(...intervals);
    const max = Math.max(...intervals);
    console.log(`[intervals] avg=${avg.toFixed(1)}ms min=${min}ms max=${max}ms (expect ~200ms)`);
  }
  console.log(`[lastPos] ${lastPos}ms (expect monotonic increasing when playing=true)`);
  process.exit(0);
}, 3000);