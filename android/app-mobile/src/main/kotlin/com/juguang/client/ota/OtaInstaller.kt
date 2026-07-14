package com.juguang.client.ota

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

/**
 * APK 下载 + 安装器
 *
 * 简化版: 用 OkHttp 同步下载到 filesDir/updates/，完成后弹安装对话框
 * 完整版可用 DownloadManager，但 v0.1 简单点
 */
object OtaInstaller {
    private const val TAG = "OtaInstaller"

    /**
     * 在 UI 上展示更新对话框
     */
    fun showUpdateDialog(
        ctx: Context,
        info: OtaChecker.UpdateInfo,
        serverUrl: String,
        onInstalled: () -> Unit
    ) {
        val title = if (info.mandatory) "强制更新" else "发现新版本"
        val msg = buildString {
            append("新版本: ${info.versionName}\n")
            append("当前: ${com.juguang.client.BuildConfig.VERSION_NAME}\n")
            if (info.notes.isNotBlank()) append("\n${info.notes}")
        }
        AlertDialog.Builder(ctx)
            .setTitle(title)
            .setMessage(msg)
            .setPositiveButton("立即下载") { _, _ ->
                Thread {
                    downloadAndInstall(ctx, info, serverUrl, onInstalled)
                }.start()
            }
            .setNegativeButton("稍后", null)
            .setCancelable(!info.mandatory)
            .show()
    }

    private fun downloadAndInstall(
        ctx: Context,
        info: OtaChecker.UpdateInfo,
        serverUrl: String,
        onInstalled: () -> Unit
    ) {
        try {
            val apkUrl = info.apkUrl.let { if (it.startsWith("http")) it else serverUrl + it }
            Log.i(TAG, "downloading $apkUrl")
            val dir = File(ctx.filesDir, "updates").apply { mkdirs() }
            val apk = File(dir, "juguang-${info.versionName}.apk")
            val conn = java.net.URL(apkUrl).openConnection()
            conn.connectTimeout = 10000
            conn.readTimeout = 60000
            conn.getInputStream().use { input ->
                FileOutputStream(apk).use { output ->
                    val buf = ByteArray(8192)
                    var n: Int
                    while (input.read(buf).also { n = it } > 0) output.write(buf, 0, n)
                }
            }
            Log.i(TAG, "downloaded to ${apk.absolutePath}, size=${apk.length()}")
            installApk(ctx, apk)
            onInstalled()
        } catch (e: Exception) {
            Log.e(TAG, "download/install failed: ${e.message}", e)
        }
    }

    private fun installApk(ctx: Context, apk: File) {
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", apk)
        } else {
            Uri.fromFile(apk)
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        ctx.startActivity(intent)
    }
}