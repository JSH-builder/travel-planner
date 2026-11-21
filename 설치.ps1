# 여행 계획 앱 설치 (Windows). '설치.bat'을 더블클릭하면 실행됩니다.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Update-PathFromRegistry {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host "`n🧳 여행 계획 앱 설치를 시작합니다`n"

# 1. Python
$py = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "• Python 3.12 설치 중..."
    winget install --id Python.Python.3.12 -e --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
}
if (-not (Test-Path $py)) { throw "Python 설치에 실패했습니다. python.org에서 Python 3.12를 설치한 뒤 다시 실행해 주세요." }
Write-Host "✅ Python 준비됨"

# 2. 가상환경 + 패키지
if (-not (Test-Path ".venv")) { & $py -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip -q
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt -q
Write-Host "✅ 패키지 설치됨"

# 3. Claude Code (AI 계획 생성용, 본인 Claude 구독으로 로그인)
Update-PathFromRegistry
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "• Claude Code 설치 중..."
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Update-PathFromRegistry
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "✅ Claude Code 준비됨 — 아직 로그인 전이면 새 터미널에서 'claude'를 실행해 로그인하세요 (Claude Pro/Max 구독 계정)"
} else {
    Write-Host "⚠️ Claude Code를 설치하지 못했습니다. https://claude.ai/code 안내에 따라 직접 설치해 주세요."
}

Write-Host "`n설치 완료! 다음 단계는 README의 '처음 설정'을 따라 주세요.`n"
