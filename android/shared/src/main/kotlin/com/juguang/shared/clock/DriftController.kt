package com.juguang.shared.clock

import com.juguang.shared.protocol.Constants
import com.juguang.shared.player.PlayerEngine

/**
 * 漂移修正控制器 - 复刻 web/sync.js adjustDrift
 *
 * 三段式:
 *  |drift| < 30ms  -> 死区，不动
 *  30-500ms        -> playbackRate ±1.5% 微调 (P 控制器)
 *  > 500ms         -> 硬 seek + 冷却 2s
 */
class DriftController(
    private val clock: NtpClock
) {
    companion object { private const val TAG = "DriftController" }

    private var seekCount = 0
    private var lastSeekTime = 0L

    /**
     * 计算期望播放位置
     * @param startServerTime play 消息中的起播时刻
     * @param trackOffsetMs 曲内偏移
     * @return 期望位置 (ms)
     */
    fun expectedPosition(startServerTime: Long, trackOffsetMs: Long): Long {
        val serverNow = clock.serverNow()
        return (serverNow - startServerTime) + trackOffsetMs
    }

    /**
     * 执行漂移修正
     * @param player 播放器实例
     * @param startServerTime play 消息中的起播时刻
     * @param trackOffsetMs 曲内偏移
     * @return 修正动作描述
     */
    fun correct(
        player: PlayerEngine,
        startServerTime: Long,
        trackOffsetMs: Long
    ): CorrectionResult {
        val expected = expectedPosition(startServerTime, trackOffsetMs)
        val actual = player.currentPosition
        val drift = actual - expected

        val absDrift = kotlin.math.abs(drift)

        // 死区
        if (absDrift < Constants.DRIFT_DEADBAND_MS) {
            player.setPlaybackSpeed(1.0f)
            return CorrectionResult.Deadband(drift)
        }

        // Seek 阈值
        if (absDrift >= Constants.SEEK_THRESHOLD_MS) {
            val now = clock.now()
            // 冷却检查
            if (now - lastSeekTime < Constants.SEEK_COOLDOWN_MS) {
                return CorrectionResult.SeekCooldown(drift)
            }
            // 最大 seek 次数
            if (seekCount >= Constants.MAX_DRIFT_SEEKS) {
                return CorrectionResult.MaxSeeksReached(drift)
            }
            // 缓冲检查
            if (player.bufferedPosition - player.currentPosition < Constants.MIN_BUFFER_FOR_SEEK_MS) {
                return CorrectionResult.InsufficientBuffer(drift)
            }
            player.seekTo(expected)
            lastSeekTime = now
            seekCount++
            return CorrectionResult.Seek(drift)
        }

        // 微调区: P 控制器
        // speed = 1 + clamp(drift / (RATE_SERVO_HORIZON_S * 1000), -RATE_SERVO_MAX, RATE_SERVO_MAX)
        val rawCorrection = drift.toDouble() / (Constants.RATE_SERVO_HORIZON_S * 1000.0)
        val clamped = rawCorrection.coerceIn(
            -Constants.RATE_SERVO_MAX,
            Constants.RATE_SERVO_MAX
        )
        val speed = (1.0 + clamped).toFloat()
        player.setPlaybackSpeed(speed)
        return CorrectionResult.RateAdjust(drift, speed)
    }

    fun reset() {
        seekCount = 0
        lastSeekTime = 0L
    }
}

sealed class CorrectionResult {
    abstract val driftMs: Long
    data class Deadband(override val driftMs: Long) : CorrectionResult()
    data class RateAdjust(override val driftMs: Long, val speed: Float) : CorrectionResult()
    data class Seek(override val driftMs: Long) : CorrectionResult()
    data class SeekCooldown(override val driftMs: Long) : CorrectionResult()
    data class MaxSeeksReached(override val driftMs: Long) : CorrectionResult()
    data class InsufficientBuffer(override val driftMs: Long) : CorrectionResult()
}
