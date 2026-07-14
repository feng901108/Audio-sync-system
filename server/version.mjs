// 鐗堟湰淇℃伅 - OTA 鍗囩骇鐢?// 鍗囩骇娴佺▼: 鏀硅繖閲岀殑 VERSION_CODE, 鎶婃柊 APK 鏀惧埌 web/apk/ 鐩綍, app 绔惎鍔ㄦ椂浼氳嚜鍔ㄦ煡
export const VERSION_CODE = 2;
export const VERSION_NAME = "0.2.0";
export const APK_FILENAME = `juguang-${VERSION_NAME}.apk`;

/**
 * GET /api/version 杩斿洖鍐呭
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
