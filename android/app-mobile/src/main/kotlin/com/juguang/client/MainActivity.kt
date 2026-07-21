package com.juguang.client

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.StrictMode

/**
 * 启动器: 转发到 SyncActivity (真实业务 Activity)
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        StrictMode.setThreadPolicy(
            StrictMode.ThreadPolicy.Builder()
                .detectAll()
                .penaltyLog()
                .build()
        )
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, SyncActivity::class.java))
        finish()
    }
}