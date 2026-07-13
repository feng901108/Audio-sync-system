package com.juguang.tv

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import com.juguang.shared.protocol.Constants

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply {
            text = "聚光广播 TV - 等待接入\n\n协议层: Constants 已加载\nPing=${Constants.PING_INTERVAL_MS}ms"
            textSize = 20f
            setPadding(64, 64, 64, 64)
        }
        setContentView(tv)
    }
}
