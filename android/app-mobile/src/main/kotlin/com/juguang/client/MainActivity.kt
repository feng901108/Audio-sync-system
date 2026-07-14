package com.juguang.client

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * 启动器: 转发到 SyncActivity (真实业务 Activity)
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, SyncActivity::class.java))
        finish()
    }
}