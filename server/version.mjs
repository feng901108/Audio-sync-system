// 版本信息 - OTA 升级用
// 升级流程: 改这里的 VERSION_CODE, 把新 APK 放到 web/apk/ 目录, app 端启动时会自动查
export const VERSION_CODE = 2;
export const VERSION_NAME = "0.2.0";
export const APK_FILENAME = `juguang-${VERSION_NAME}.apk`;

/**
 * GET /api/version 返回内容
 */
export function getVersionJson() {
    return {
        versionCode: VERSION_CODE,
        versionName: VERSION_NAME,
        apkUrl: `/apk/${APK_FILENAME}`,
        mandatory: false,
        notes: ""
    };
}
