@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 또는 24를 먼저 설치해 주세요.
  echo 설치 후 이 창을 닫고 START_WINDOWS.bat을 다시 실행하세요.
  pause
  exit /b 1
)
node -e "const major=Number(process.versions.node.split('.')[0]);process.exit(major===22||major===24?0:1)"
if errorlevel 1 (
  echo Node.js 22 또는 24를 사용해 주세요.
  pause
  exit /b 1
)
set PORT=3000
echo.
echo 친구들의 카드룸 서버를 시작합니다.
echo 브라우저 주소창에 http://localhost:3000 을 입력하세요.
echo 이 창을 닫으면 로컬 서버와 방이 종료됩니다.
echo 인터넷의 친구들과 함께하려면 Render 배포를 사용하세요.
echo.
node server.mjs
pause
