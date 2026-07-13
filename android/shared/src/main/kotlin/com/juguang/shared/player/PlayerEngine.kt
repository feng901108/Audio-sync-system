package com.juguang.shared.player

/**
 * 播放器抽象接口 - ExoPlayer 实现这个接口
 * 让 app-mobile 和 app-tv 共用同一套同步逻辑
 */
interface PlayerEngine {
    fun prepare(url: String, offsetMs: Long)
    fun play()
    fun pause()
    fun stop()
    fun seekTo(positionMs: Long)
    fun setVolume(volume: Float)          // master * local
    fun setPlaybackSpeed(speed: Float)    // 纯重采样: PlaybackParameters(speed, speed)
    val currentPosition: Long             // ms
    val bufferedPosition: Long            // ms
    val isPlaying: Boolean
    val duration: Long
}
