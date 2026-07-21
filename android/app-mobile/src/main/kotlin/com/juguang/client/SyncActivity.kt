package com.juguang.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.View
import android.view.animation.AnimationUtils
import android.widget.*
import com.juguang.client.ota.OtaChecker
import com.juguang.client.ota.OtaInstaller
import com.juguang.shared.clock.DriftController
import com.juguang.shared.clock.NtpClock
import com.juguang.shared.player.ExoPlayerEngine
import com.juguang.shared.player.PlayerEngine
import com.juguang.shared.protocol.*
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 真实收听端 Activity - Apple Music 风
 *
 * 阶段:
 *  - JOIN: 输入服务端地址 + 设备名, 点"加入广播"
 *  - PLAYER: 连接 WS, 等服务端下发 play, ExoPlayer 播放
 *
 * OTA: 每次连上服务端后, 异步查 /api/version, 有新版本弹对话框
 */
class SyncActivity : Activity(), SyncClient.SyncListener {

    companion object {
        private const val TAG = "SyncActivity"
        private const val PREF_NAME = "juguang_prefs"
        private const val PREF_SERVER = "server_url"
        private const val PREF_DEVICE = "device_name"
    }

    // --- prefs ---
    private lateinit var prefs: SharedPreferences

    // --- join 阶段 view ---
    private lateinit var joinContainer: ScrollView
    private lateinit var editServer: EditText
    private lateinit var editDevice: EditText
    private lateinit var btnJoin: Button
    private lateinit var textError: TextView
    private lateinit var textServers: TextView

    // --- player 阶段 view ---
    private lateinit var playerContainer: LinearLayout
    private lateinit var albumArt: ImageView
    private lateinit var textTitle: TextView
    private lateinit var textEmptyHint: TextView
    private lateinit var textZone: TextView
    private lateinit var textPosition: TextView
    private lateinit var textDuration: TextView
    private lateinit var progressFill: View
    private lateinit var textDevice: TextView
    private lateinit var textOffset: TextView
    private lateinit var textDrift: TextView
    private lateinit var textRtt: TextView
    private lateinit var seekVolume: SeekBar
    private lateinit var statusDot: View
    private lateinit var textStatus: TextView
    private lateinit var btnSettings: Button

    private val mainHandler = Handler(Looper.getMainLooper())
    private var isPlaying = false

    // --- 同步层 ---
    private lateinit var clock: NtpClock
    private lateinit var drift: DriftController
    private lateinit var player: ExoPlayerEngine
    private var sync: SyncClient? = null
    private var currentPlay: PlayMsg? = null
    private var driftJob: Job? = null
    private var progressJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // --- 配置 ---
    private var serverUrl: String = ""
    private var deviceName: String = ""
    private var zoneId: Int = 1
    private var zoneName: String = ""
    private var connected = false
    private var joined = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTheme(R.style.Theme_Juguang)
        setContentView(R.layout.activity_sync)
        prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

        // bind views
        joinContainer = findViewById(R.id.join_container)
        editServer = findViewById(R.id.edit_server)
        editDevice = findViewById(R.id.edit_device)
        btnJoin = findViewById(R.id.btn_join)
        textError = findViewById(R.id.text_error)
        textServers = findViewById(R.id.text_servers)

        playerContainer = findViewById(R.id.player_container)
        albumArt = findViewById(R.id.album_art)
        textTitle = findViewById(R.id.text_title)
        textEmptyHint = findViewById(R.id.text_empty_hint)
        textZone = findViewById(R.id.text_zone)
        textPosition = findViewById(R.id.text_position)
        textDuration = findViewById(R.id.text_duration)
        progressFill = findViewById(R.id.progress_fill)
        textDevice = findViewById(R.id.text_device)
        textOffset = findViewById(R.id.text_offset)
        textDrift = findViewById(R.id.text_drift)
        textRtt = findViewById(R.id.text_rtt)
        seekVolume = findViewById(R.id.seek_volume)
        statusDot = findViewById(R.id.status_dot)
        textStatus = findViewById(R.id.text_status)
        btnSettings = findViewById(R.id.btn_settings)

        // 恢复上次的输入
        editServer.setText(prefs.getString(PREF_SERVER, ""))
        val savedName = prefs.getString(PREF_DEVICE, "")
        if (savedName.isNullOrBlank()) {
            editDevice.setText("Phone-${(1000..9999).random()}")
        } else {
            editDevice.setText(savedName)
        }

        // 延迟初始化：避免冷启动时网络 IO 抢占导致 ANR
        mainHandler.postDelayed({
            // OTA 检查 (用已保存的服务端地址)
            val savedServer = prefs.getString(PREF_SERVER, "")
            if (!savedServer.isNullOrBlank()) {
                checkOtaInBackground(savedServer)
            }
        }, 1000)

        btnJoin.setOnClickListener { onJoinClicked() }
        btnSettings.setOnClickListener { onSettingsClicked() }
        seekVolume.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    val v = progress / 100f
                    player.setLocalVolume(v)
                    sync?.reportVolume(v)
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })
    }

    private fun showServerHints() {
        scope.launch(Dispatchers.IO) {
            try {
                val ips = resolveServerIps()
                mainHandler.post {
                    if (ips.isNotEmpty()) {
                        textServers.text = "同网段可访问: " + ips.joinToString("  ") { "http://$it" }
                    } else {
                        textServers.text = "无法探测服务端 IP, 请手动输入"
                    }
                }
            } catch (_: Exception) {}
        }
    }

    /**
     * 通过 /api/health 拿到 serverIps, 客户端再访问一下看哪个能连通
     * v0.1 简化为: 让用户输入 1 个候选 (本机 WLAN IP)
     */
    private fun resolveServerIps(): List<String> {
        return try {
            // 优先尝试本机 192.168.90.55:3000 拿 serverIps
            val candidates = listOf("192.168.90.55:3000")
            for (c in candidates) {
                try {
                    val req = Request.Builder().url("http://$c/api/health").build()
                    val resp = OkHttpClient.Builder()
                        .connectTimeout(2, TimeUnit.SECONDS)
                        .build()
                        .newCall(req).execute()
                    if (resp.isSuccessful) {
                        val body = resp.body?.string() ?: continue
                        val j = JSONObject(body)
                        val arr = j.optJSONArray("serverIps") ?: continue
                        val ips = mutableListOf<String>()
                        for (i in 0 until arr.length()) {
                            val addr = arr.getJSONObject(i).optString("address")
                            val port = j.optInt("port", 3000)
                            if (addr.isNotBlank()) ips.add("$addr:$port")
                        }
                        if (ips.isNotEmpty()) return ips
                    }
                } catch (_: Exception) {}
            }
            emptyList()
        } catch (_: Exception) { emptyList() }
    }

    private fun onJoinClicked() {
        val raw = editServer.text.toString().trim()
        if (TextUtils.isEmpty(raw)) {
            textError.text = "请输入服务端地址"
            textError.visibility = View.VISIBLE
            return
        }
        textError.visibility = View.GONE
        serverUrl = normalizeServerUrl(raw)
        deviceName = editDevice.text.toString().trim().ifBlank { "Phone" }
        zoneId = 1

        // 保存
        prefs.edit()
            .putString(PREF_SERVER, serverUrl)
            .putString(PREF_DEVICE, deviceName)
            .apply()

        btnJoin.text = "连接中…"
        btnJoin.isEnabled = false

        // 初始化同步层
        clock = NtpClock()
        drift = DriftController(clock)
        player = ExoPlayerEngine(this)
        sync = SyncClient(serverUrl, clock, this).apply {
            setDeviceInfo(deviceName, "android-phone", zoneId, null, supportsSyncTicks = false)
            connect()
        }

        // 不直接切 player——等 onConnected 回调
        // 超时保护: 10 秒后仍连不上则回 join 页面
        scope.launch {
            delay(10_000)
            if (!connected && !joined) {
                mainHandler.post {
                    btnJoin.text = getString(R.string.join_btn)
                    btnJoin.isEnabled = true
                    textError.text = "连接超时，请检查服务端地址和网络"
                    textError.visibility = View.VISIBLE
                }
            }
        }
    }

    private fun onSettingsClicked() {
        // 简单实现: 回到 join 页面
        sync?.disconnect()
        sync = null
        driftJob?.cancel()
        progressJob?.cancel()
        player.release()
        playerContainer.visibility = View.GONE
        joinContainer.visibility = View.VISIBLE
        joined = false
        btnJoin.text = getString(R.string.join_btn)
        btnJoin.isEnabled = true
    }

    override fun onDestroy() {
        super.onDestroy()
        driftJob?.cancel()
        progressJob?.cancel()
        scope.cancel()
        sync?.disconnect()
        if (::player.isInitialized) player.release()
    }

    // ============ OTA ============

    private fun checkOtaInBackground(url: String = serverUrl) {
        scope.launch {
            try {
                Log.i(TAG, "OTA check start, serverUrl=$url")
                val update = OtaChecker.check(url)
                if (update != null) {
                    Log.i(TAG, "OTA update found: ${update.versionName}")
                    OtaInstaller.showUpdateDialog(this@SyncActivity, update, url) {
                        Log.i(TAG, "user accepted install")
                    }
                } else {
                    Log.i(TAG, "OTA: no update or check failed silently")
                }
            } catch (e: Exception) {
                Log.w(TAG, "ota check failed: ${e.message}")
            }
        }
    }

    // ============ SyncClient.SyncListener ============

    override fun onConnected(deviceId: String) {
        connected = true
        joined = true

        // 切到 player 页面
        joinContainer.visibility = View.GONE
        playerContainer.visibility = View.VISIBLE

        textDevice.text = "$deviceName · ${deviceId.take(6)}"
        statusDot.setBackgroundResource(R.drawable.dot_ok)
        textStatus.text = getString(R.string.status_connected)
        textZone.text = zoneName.ifBlank { "默认分区" }
        textZone.visibility = View.VISIBLE
        startDriftLoop()
        startProgressLoop()

        // 连接成功后检查 OTA
        checkOtaInBackground(serverUrl)
    }

    override fun onDisconnected() {
        connected = false
        if (!joined) {
            // 初始连接失败——回 join 页面
            mainHandler.post {
                btnJoin.text = getString(R.string.join_btn)
                btnJoin.isEnabled = true
                textError.text = "连接失败，请检查服务端地址"
                textError.visibility = View.VISIBLE
            }
            return
        }
        statusDot.setBackgroundResource(R.drawable.dot_warn)
        textStatus.text = getString(R.string.status_disconnected)
        stopAlbumSpin()
    }

    override fun onPlay(msg: PlayMsg) {
        currentPlay = msg
        textTitle.text = msg.trackId
        textEmptyHint.visibility = View.GONE
        textDuration.text = fmt(msg.durationMs)
        scope.launch {
            val wait = (msg.startServerTime - clock.serverNow()).coerceAtLeast(0)
            if (wait > 0) delay(wait)
            try {
                player.prepare(serverUrl + msg.trackUrl, msg.trackOffsetMs)
                player.play()
                sync?.reportLoaded(player.bufferedPosition)
                Log.i(TAG, "playing ${msg.trackId}")
            } catch (e: Exception) {
                Log.e(TAG, "play failed: ${e.message}", e)
            }
        }
    }

    override fun onPause(msg: PauseMsg) {
        scope.launch {
            val wait = (msg.atServerTime - clock.serverNow()).coerceAtLeast(0)
            if (wait > 0) delay(wait)
            player.pause()
        }
    }

    override fun onStop(msg: StopMsg) {
        player.stop()
        currentPlay = null
        textTitle.text = getString(R.string.player_waiting)
        textEmptyHint.visibility = View.VISIBLE
        stopAlbumSpin()
    }

    override fun onSetVolume(volume: Float) {
        player.setVolume(volume)
    }

    override fun onError(message: String) {
        Log.e(TAG, "sync error: $message")
        mainHandler.post { textStatus.text = "错误: $message" }
    }

    // ============ UI loops ============

    private fun startDriftLoop() {
        driftJob?.cancel()
        driftJob = scope.launch {
            while (isActive && connected) {
                val play = currentPlay ?: continue
                if (player.isPlaying) {
                    val expected = drift.expectedPosition(play.startServerTime, play.trackOffsetMs)
                    val result = drift.correct(player, play.startServerTime, play.trackOffsetMs)
                    mainHandler.post {
                        textOffset.text = "${clock.clockOffset()} ms"
                        textDrift.text = "${result.driftMs} ms"
                        textRtt.text = "${clock.minRtt()} ms"
                        isPlaying = true
                        startAlbumSpin()
                    }
                } else {
                    isPlaying = false
                    stopAlbumSpin()
                }
                delay(Constants.DRIFT_CHECK_MS)
            }
        }
    }

    private fun startProgressLoop() {
        progressJob?.cancel()
        progressJob = scope.launch {
            while (isActive && connected) {
                val play = currentPlay ?: continue
                if (player.isPlaying) {
                    val pos = player.currentPosition
                    val dur = player.duration.takeIf { it > 0 } ?: play.durationMs
                    val pct = if (dur > 0) (pos.toFloat() / dur * 100).toInt().coerceIn(0, 100) else 0
                    mainHandler.post {
                        textPosition.text = fmt(pos)
                        textDuration.text = fmt(dur)
                        progressFill.layoutParams = (progressFill.layoutParams as FrameLayout.LayoutParams).apply {
                            width = (progressFill.parent as FrameLayout).width * pct / 100
                        }
                        progressFill.requestLayout()
                    }
                }
                delay(500)
            }
        }
    }

    private fun startAlbumSpin() {
        if (albumArt.animation == null) {
            val anim = AnimationUtils.loadAnimation(this, R.anim.spin_album)
            albumArt.startAnimation(anim)
        }
    }

    private fun stopAlbumSpin() {
        if (albumArt.animation != null) {
            albumArt.clearAnimation()
        }
    }

    // ============ helpers ============

    private fun normalizeServerUrl(raw: String): String {
        var s = raw.trim()
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s.trimEnd('/')
    }

    private fun fmt(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
    }
}