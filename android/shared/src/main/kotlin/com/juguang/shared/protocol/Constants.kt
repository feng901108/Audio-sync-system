package com.juguang.shared.protocol

/**
 * 同步参数 - single source of truth
 * 来源: docs/android-port-guide.md §10
 * 与 web/sync.js 常量逐一对齐
 */
object Constants {
    // NTP 时钟同步
    const val PING_INTERVAL_MS = 2000L
    const val PING_BURST_COUNT = 5
    const val PING_BURST_INTERVAL_MS = 100L
    const val CLOCK_SAMPLE_WINDOW = 10
    const val CLOCK_MIN_RTT_SAMPLES = 3

    // 漂移修正
    const val DRIFT_CHECK_MS = 500L
    const val DRIFT_DEADBAND_MS = 30L
    const val RATE_SERVO_MAX = 0.015          // ±1.5%
    const val RATE_SERVO_HORIZON_S = 8.0      // P 控制器收敛时间常数
    const val SEEK_THRESHOLD_MS = 500L
    const val SEEK_COOLDOWN_MS = 2000L
    const val MAX_DRIFT_SEEKS = 10
    const val MIN_BUFFER_FOR_SEEK_MS = 1000L

    // 网络容错
    const val RECONNECT_BASE_MS = 1500L
    const val RECONNECT_MAX_MS = 30000L
    const val MAX_ERROR_RETRIES = 3
    const val ERROR_RETRY_DELAY_MS = 1000L

    // 服务端心跳 (协议层 ping/pong，OkHttp pingInterval)
    const val HEARTBEAT_INTERVAL_MS = 10000L
    const val HEARTBEAT_GRACE_MS = 12000L

    // 音量
    const val VOLUME_RAMP_MS = 100L
}
