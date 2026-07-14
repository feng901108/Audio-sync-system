package com.juguang.shared.protocol

import android.util.Log
import com.juguang.shared.clock.NtpClock
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.util.concurrent.TimeUnit

/**
 * WebSocket 同步客户端
 * 复刻 web/sync.js 的连接逻辑：register -> ping/pong -> play/pause/stop
 */
class SyncClient(
    private val serverUrl: String,
    private val ntpClock: NtpClock,
    private val listener: SyncListener,
    private val mainHandler: android.os.Handler? = null
) {
    companion object { private const val TAG = "SyncClient" }

    /**
     * 所有 listener 通知都切换到主线程 (UI 操作必须在主线程)
     * 如果外部没传 mainHandler, 用默认 (UI 线程) Looper 创建
     */
    private val uiHandler: android.os.Handler = mainHandler
        ?: android.os.Handler(android.os.Looper.getMainLooper())

    /** 包装 listener: 把回调强制切到主线程 */
    private val mainListener: SyncListener = object : SyncListener {
        override fun onConnected(deviceId: String) {
            uiHandler.post { listener.onConnected(deviceId) }
        }
        override fun onDisconnected() {
            uiHandler.post { listener.onDisconnected() }
        }
        override fun onPlay(msg: PlayMsg) {
            uiHandler.post { listener.onPlay(msg) }
        }
        override fun onPause(msg: PauseMsg) {
            uiHandler.post { listener.onPause(msg) }
        }
        override fun onStop(msg: StopMsg) {
            uiHandler.post { listener.onStop(msg) }
        }
        override fun onSetVolume(volume: Float) {
            uiHandler.post { listener.onSetVolume(volume) }
        }
        override fun onError(message: String) {
            uiHandler.post { listener.onError(message) }
        }
    }

    interface SyncListener {
        fun onConnected(deviceId: String)
        fun onDisconnected()
        fun onPlay(msg: PlayMsg)
        fun onPause(msg: PauseMsg)
        fun onStop(msg: StopMsg)
        fun onSetVolume(volume: Float)
        fun onError(message: String)
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var ws: WebSocket? = null
    private var deviceId: String? = null
    private var deviceName: String = "Android-Client"
    private var kind: String = "android-phone"
    private var zoneId: Int = 1
    private var supportsSyncTicks: Boolean = false

    @Volatile private var connected = false
    private var pingJob: Job? = null
    private var reconnectAttempts = 0

    private val client = OkHttpClient.Builder()
        .pingInterval(Constants.HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS)
        .build()

    private val wsUrl: String
        get() = if (serverUrl.startsWith("http")) {
            serverUrl.replace("http", "ws") + "/ws"
        } else {
            serverUrl + "/ws"
        }

    fun setDeviceInfo(name: String, kind: String, zoneId: Int, deviceId: String?, supportsSyncTicks: Boolean) {
        this.deviceName = name
        this.kind = kind
        this.zoneId = zoneId
        this.deviceId = deviceId
        this.supportsSyncTicks = supportsSyncTicks
    }

    fun connect() {
        scope.launch {
            val req = Request.Builder().url(wsUrl).build()
            ws = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.i(TAG, "WS connected: $wsUrl")
                    connected = true
                    reconnectAttempts = 0
                    sendRegister()
                    startPingLoop()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    handleMessage(bytes.utf8())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.w(TAG, "WS closed: $code $reason")
                    onDisconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(TAG, "WS failure: ${t.message}")
                    onDisconnect()
                    scheduleReconnect()
                }
            })
        }
    }

    fun disconnect() {
        pingJob?.cancel()
        ws?.close(1000, "client disconnect")
        connected = false
    }

    private fun sendRegister() {
        val msg = RegisterMsg(
            deviceId = deviceId,
            name = deviceName,
            kind = kind,
            zoneId = zoneId,
            supportsSyncTicks = supportsSyncTicks
        )
        send(json.encodeToString(RegisterMsg.serializer(), msg))
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            // 初始 burst: 5 次 x 100ms
            repeat(Constants.PING_BURST_COUNT) {
                sendPing()
                delay(Constants.PING_BURST_INTERVAL_MS)
            }
            // 常规: 每 2s
            while (isActive) {
                sendPing()
                delay(Constants.PING_INTERVAL_MS)
            }
        }
    }

    private fun sendPing() {
        val t0 = ntpClock.now()
        val msg = PingMsg(t0 = t0)
        send(json.encodeToString(PingMsg.serializer(), msg))
    }

    fun reportLoaded(loadedMs: Long) {
        val msg = ReportLoadedMsg(loadedMs = loadedMs)
        send(json.encodeToString(ReportLoadedMsg.serializer(), msg))
    }

    fun reportVolume(volume: Float) {
        val msg = SetVolumeMsg(volume = volume.coerceIn(0f, 1f))
        send(json.encodeToString(SetVolumeMsg.serializer(), msg))
    }

    private fun handleMessage(text: String) {
        try {
            val obj = json.parseToJsonElement(text).jsonObject
            val type = obj["type"]?.jsonPrimitive?.content ?: return

            when (type) {
                "hello" -> {
                    val msg = json.decodeFromJsonElement(HelloMsg.serializer(), obj)
                    deviceId = msg.deviceId
                    Log.i(TAG, "Registered: deviceId=${msg.deviceId} zone=${msg.zoneId}")
                    mainListener.onConnected(msg.deviceId)
                }
                "pong" -> {
                    val msg = json.decodeFromJsonElement(PongMsg.serializer(), obj)
                    ntpClock.onPong(msg.t0, msg.t1)
                }
                "play", "seek" -> {
                    val msg = json.decodeFromJsonElement(PlayMsg.serializer(), obj)
                    Log.i(TAG, "Play: track=${msg.trackId} start=${msg.startServerTime} offset=${msg.trackOffsetMs}")
                    mainListener.onPlay(msg)
                }
                "pause" -> {
                    val msg = json.decodeFromJsonElement(PauseMsg.serializer(), obj)
                    mainListener.onPause(msg)
                }
                "stop" -> {
                    val msg = json.decodeFromJsonElement(StopMsg.serializer(), obj)
                    mainListener.onStop(msg)
                }
                "setVolume" -> {
                    val msg = json.decodeFromJsonElement(SetVolumeMsg.serializer(), obj)
                    mainListener.onSetVolume(msg.volume)
                }
                "sync" -> {
                    // v4 sync tick - 暂存，v4 合 main 后启用
                    val msg = json.decodeFromJsonElement(SyncTickMsg.serializer(), obj)
                    Log.d(TAG, "SyncTick: pos=${msg.positionMs} playing=${msg.isPlaying}")
                }
                else -> Log.w(TAG, "Unknown message type: $type")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Parse error: ${e.message}", e)
        }
    }

    private fun send(text: String) {
        val w = ws
        if (w != null) {
            val ok = w.send(text)
            if (!ok) Log.w(TAG, "WS send failed (queue full or closed)")
        }
    }

    private fun onDisconnect() {
        connected = false
        pingJob?.cancel()
        mainListener.onDisconnected()
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        scope.launch {
            val delay = minOf(
                Constants.RECONNECT_BASE_MS * (1L shl reconnectAttempts.coerceAtMost(5)),
                Constants.RECONNECT_MAX_MS
            )
            reconnectAttempts++
            Log.i(TAG, "Reconnect in ${delay}ms (attempt $reconnectAttempts)")
            delay(delay)
            if (!connected) connect()
        }
    }

    fun isConnected(): Boolean = connected
    fun getDeviceId(): String? = deviceId
}
