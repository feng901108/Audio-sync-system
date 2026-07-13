package com.juguang.client

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import com.juguang.shared.protocol.Constants

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }
        val title = TextView(this).apply {
            text = "聚光广播 - 收听端"
            textSize = 24f
            setPadding(0, 0, 0, 32)
        }
        val info = TextView(this).apply {
            text = "协议层已就绪\nPing=${Constants.PING_INTERVAL_MS}ms\nDrift=${Constants.DRIFT_CHECK_MS}ms\nSeek=${Constants.SEEK_THRESHOLD_MS}ms\n\n下一步: 接入 WebSocket + ExoPlayer"
            textSize = 14f
        }
        layout.addView(title)
        layout.addView(info)
        setContentView(layout)
    }
}
