package com.juguang.shared.player

import android.content.Context
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.datasource.DefaultDataSource
import com.juguang.shared.protocol.Constants

/**
 * ExoPlayer 实现 PlayerEngine 接口
 *
 * 关键设计 (android-port-guide.md §4/§5/§7):
 * - setPlaybackSpeed: 用 PlaybackParameters(speed, speed) 双参版本 = 纯重采样 + pitch 跟 speed
 *   绝不用单参版本（会走 Sonic 时间拉伸 -> 陶瓷罐音）
 * - setVolume: master * local 复合音量
 * - prepare: 从指定 offset 开始
 */
class ExoPlayerEngine(
    private val context: Context,
    private var localVolume: Float = 1.0f
) : PlayerEngine {

    companion object { private const val TAG = "ExoPlayerEngine" }

    private var masterVolume: Float = 1.0f
    private var currentSpeed: Float = 1.0f

    private val player: ExoPlayer = ExoPlayer.Builder(context)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            true  // handleAudioFocus
        )
        .setHandleAudioBecomingNoisy(true)
        .build()

    init {
        player.playWhenReady = false
        player.repeatMode = ExoPlayer.REPEAT_MODE_OFF
    }

    override fun prepare(url: String, offsetMs: Long) {
        Log.i(TAG, "prepare: url=$url offset=$offsetMs")
        val dataSourceFactory = DefaultDataSource.Factory(context)
        val mediaSource = ProgressiveMediaSource.Factory(dataSourceFactory)
            .createMediaSource(androidx.media3.common.MediaItem.fromUri(url))
        player.setMediaSource(mediaSource, offsetMs)
        player.prepare()
    }

    override fun play() {
        Log.i(TAG, "play")
        player.playWhenReady = true
    }

    override fun pause() {
        Log.i(TAG, "pause")
        player.playWhenReady = false
    }

    override fun stop() {
        Log.i(TAG, "stop")
        player.stop()
    }

    override fun seekTo(positionMs: Long) {
        Log.i(TAG, "seekTo: $positionMs")
        player.seekTo(positionMs)
    }

    /**
     * master * local 复合音量
     */
    override fun setVolume(volume: Float) {
        masterVolume = volume.coerceIn(0f, 1f)
        val composite = (masterVolume * localVolume).coerceIn(0f, 1f)
        player.volume = composite
    }

    /**
     * 设置本地音量 (不影响 master)
     */
    fun setLocalVolume(vol: Float) {
        localVolume = vol.coerceIn(0f, 1f)
        setVolume(masterVolume)
    }

    /**
     * 播放速率微调
     * 范围仅 ±1.5%，Sonic 时间拉伸副作用可忽略，保 pitch 优先
     * 单参 PlaybackParameters(speed) = speed-only, 音高不变
     */
    override fun setPlaybackSpeed(speed: Float) {
        val clamped = speed.coerceIn(
            (1f - Constants.RATE_SERVO_MAX).toFloat(),
            (1f + Constants.RATE_SERVO_MAX).toFloat()
        )
        if (kotlin.math.abs(clamped - currentSpeed) < 0.0001f) return
        currentSpeed = clamped
        player.playbackParameters = PlaybackParameters(clamped)
        Log.d(TAG, "setPlaybackSpeed: $clamped (pitch-preserving)")
    }

    override val currentPosition: Long
        get() = player.currentPosition

    override val bufferedPosition: Long
        get() = player.bufferedPosition

    override val isPlaying: Boolean
        get() = player.isPlaying

    override val duration: Long
        get() = player.duration.takeIf { it > 0 } ?: 0L

    fun release() {
        player.release()
    }

    fun addListener(listener: androidx.media3.common.Player.Listener) {
            player.addListener(listener)
        }
}
