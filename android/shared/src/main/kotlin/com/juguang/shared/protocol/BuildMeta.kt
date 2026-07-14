package com.juguang.shared.protocol

/**
 * 编译期元信息 - 在编译时被替换为真实值
 *
 * 通过 BuildConfig 注入 (BuildConfig 由 app-mobile/build.gradle 生成)
 * shared 模块不能直接拿 BuildConfig, 所以用一个常量类做桥接
 */
object BuildMeta {
    /** 由 app-mobile/build.gradle 的 buildConfigField 注入 */
    const val VERSION_CODE: Int = 1
    const val VERSION_NAME: String = "0.1.0"
}