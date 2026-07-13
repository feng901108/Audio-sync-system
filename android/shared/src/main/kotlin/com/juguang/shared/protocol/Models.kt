package com.juguang.shared.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName

// === 客户端 -> 服务端 ===

@Serializable
data class RegisterMsg(
    val type: String = "register",
    val deviceId: String? = null,
    val name: String,
    val kind: String,            // "android-tv" / "android-phone"
    val zoneId: Int = 1,
    @SerialName("supportsSyncTicks") val supportsSyncTicks: Boolean = false
)

@Serializable
data class PingMsg(
    val type: String = "ping",
    val t0: Long                 // epoch ms
)

@Serializable
data class ReportLoadedMsg(
    val type: String = "reportLoaded",
    val loadedMs: Long
)

// === 服务端 -> 客户端 ===

@Serializable
data class HelloMsg(
    val type: String = "hello",
    val deviceId: String,
    val zoneId: Int,
    val serverTime: Long,
    val ip: String? = null
)

@Serializable
data class PlayMsg(
    val type: String,             // "play" 或 "seek"
    val zoneId: Int,
    val trackId: String,
    val trackUrl: String,
    val durationMs: Long,
    val startServerTime: Long,    // 未来时刻，app 在此时刻起播
    val trackOffsetMs: Long       // 曲内偏移（seek 时变化）
)

@Serializable
data class PauseMsg(
    val type: String = "pause",
    val zoneId: Int,
    val atServerTime: Long        // 未来时刻，app 在此时刻暂停
)

@Serializable
data class StopMsg(
    val type: String = "stop",
    val zoneId: Int
)

@Serializable
data class SetVolumeMsg(
    val type: String = "setVolume",
    val volume: Float             // 0.0 - 1.0, master 音量
)

@Serializable
data class PongMsg(
    val type: String = "pong",
    val t0: Long,
    val t1: Long                  // 服务端收到 ping 的时刻
)

@Serializable
data class SyncTickMsg(
    val type: String = "sync",    // v4: 服务端广播的 sync tick
    val positionMs: Long,
    val serverNow: Long,
    val isPlaying: Boolean
)
