package com.juguang.client.ota

import android.content.Context
import android.util.Log
import com.juguang.shared.protocol.BuildMeta
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * OTA 版本检查
 *
 * 协议: GET {serverUrl}/api/version
 * 响应: {"versionCode":2,"versionName":"0.2.0","apkUrl":"/apk/juguang-0.2.0.apk","mandatory":false,"notes":"..."}
 */
object OtaChecker {
    private const val TAG = "OtaChecker"
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    data class UpdateInfo(
        val versionCode: Int,
        val versionName: String,
        val apkUrl: String,
        val mandatory: Boolean,
        val notes: String
    )

    /**
     * 查服务端最新版本
     * @return UpdateInfo 表示可升级；null 表示已是最新或网络问题
     */
    suspend fun check(serverUrl: String): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url("$serverUrl/api/version")
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "version check http ${resp.code}")
                    return@withContext null
                }
                val body = resp.body?.string() ?: return@withContext null
                val j = JSONObject(body)
                val remoteCode = j.optInt("versionCode", 0)
                if (remoteCode <= BuildMeta.VERSION_CODE) {
                    Log.i(TAG, "no update (local=${BuildMeta.VERSION_CODE}, remote=$remoteCode)")
                    return@withContext null
                }
                UpdateInfo(
                    versionCode = remoteCode,
                    versionName = j.optString("versionName", "?"),
                    apkUrl = j.optString("apkUrl", ""),
                    mandatory = j.optBoolean("mandatory", false),
                    notes = j.optString("notes", "")
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "check failed: ${e.message}")
            null
        }
    }
}