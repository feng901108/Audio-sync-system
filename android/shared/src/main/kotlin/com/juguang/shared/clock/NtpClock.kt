package com.juguang.shared.clock

import android.os.SystemClock
import com.juguang.shared.protocol.Constants

/**
 * NTP 式时钟同步 - 复刻 web/sync.js _clockOffset + _serverNow
 *
 * 关键: 用 monotonic 时钟 (elapsedRealtime) 映射到 epoch，
 * 避免系统时间被 NTP/手动修改时 offset 跳变。
 * 绝不用 uptimeMillis（不含睡眠，锁屏后会跳）。
 */
class NtpClock {

    // monotonic -> epoch 基准（App 启动时取一次）
    private val epochBase: Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

    private data class Sample(val offset: Long, val rtt: Long)
    private val samples = ArrayDeque<Sample>()

    /**
     * 处理 pong 消息，更新时钟偏移
     * @param t0 客户端发送 ping 时的 epoch ms
     * @param t1 服务端收到 ping 时的 epoch ms
     */
    fun onPong(t0: Long, t1: Long) {
        val t2 = now()
        val rtt = t2 - t0
        val offset = (t1 - t0 + (t1 - t2)) / 2  // = t1 - (t0+t2)/2
        samples.addLast(Sample(offset, rtt))
        if (samples.size > Constants.CLOCK_SAMPLE_WINDOW) samples.removeFirst()
    }

    /**
     * 取 RTT 最小的 N 个样本的 offset 中位数
     */
    fun clockOffset(): Long {
        if (samples.isEmpty()) return 0
        val sorted = samples.sortedBy { it.rtt }
        val head = sorted.take(minOf(Constants.CLOCK_MIN_RTT_SAMPLES, sorted.size))
        val offsets = head.map { it.offset }.sorted()
        return offsets[offsets.size / 2]
    }

    /**
     * 当前服务端时间 = 本地 monotonic 时间 + offset
     */
    fun serverNow(): Long = now() + clockOffset()

    /**
     * monotonic epoch: 不受系统时间修改影响
     */
    fun now(): Long = epochBase + SystemClock.elapsedRealtime()

    fun minRtt(): Long = if (samples.isEmpty()) 0 else samples.minOf { it.rtt }

    fun reset() { samples.clear() }
}
