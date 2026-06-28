@echo off
REM 聚光广播 · 本机 → NAS 一键部署（Windows 原生 shell）
REM 用法：npm run deploy:windows -- "feat: 你的改动说明"

if "%~1"=="" (
  echo ✗ 用法：npm run deploy:windows -- "commit message"
  exit /b 1
)

echo === git add + commit ===
git add -A
git commit -m "%~1" || echo "（无新改动或 commit 失败，已继续）"

echo === git push ===
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
git push origin %BRANCH% || echo "（push 失败，请手动检查）"

echo === 读 .env 拿 NAS WebDAV 路径 ===
if not exist .env (
  echo ✗ .env 不存在
  exit /b 1
)
set "NAS_WEBDAV="
for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
  if /i "%%a"=="NAS_WEBDAV" set "NAS_WEBDAV=%%b"
)
if "%NAS_WEBDAV%"=="" (
  echo ✗ .env 里没配 NAS_WEBDAV
  exit /b 1
)
echo WebDAV 目标：%NAS_WEBDAV%

if not exist "%NAS_WEBDAV%" (
  echo ✗ 找不到 %NAS_WEBDAV%，请确认 WebDAV 已挂载
  exit /b 1
)

echo === 同步文件 ===
xcopy /E /I /Y /Q "server" "%NAS_WEBDAV%\server" >nul
xcopy /E /I /Y /Q "web" "%NAS_WEBDAV%\web" >nul
copy /Y "package.json" "%NAS_WEBDAV%\" >nul
copy /Y "Dockerfile" "%NAS_WEBDAV%\" >nul
copy /Y "docker-compose.yml" "%NAS_WEBDAV%\" >nul
copy /Y "docker-compose.fnOS.yml" "%NAS_WEBDAV%\" >nul
copy /Y ".env.example" "%NAS_WEBDAV%\" >nul
copy /Y ".gitignore" "%NAS_WEBDAV%\" >nul
copy /Y ".dockerignore" "%NAS_WEBDAV%\" >nul

echo.
echo ✓ 文件同步完成
echo 下一步：在 fnOS 终端执行
echo     bash /vol1/1000/juguang/deploy.sh