$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$manifest = Get-Content -Raw kronos/manifest.json | ConvertFrom-Json
if (!(Test-Path .runtime/kronos-venv/Scripts/python.exe)) {
    py -3.13 -m venv .runtime/kronos-venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.13 is required for the local Kronos environment' }
}
if (!(Test-Path .runtime/kronos-source/.git)) {
    git clone --no-checkout https://github.com/shiyu-coder/Kronos.git .runtime/kronos-source
    if ($LASTEXITCODE -ne 0) { throw 'Kronos source download failed' }
}
git -C .runtime/kronos-source diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Local Kronos source has changes; preserve them before setup' }
git -C .runtime/kronos-source checkout --detach $manifest.source_revision
if ($LASTEXITCODE -ne 0) { throw 'Pinned Kronos revision unavailable' }
& .runtime/kronos-venv/Scripts/python.exe -m pip install --only-binary=:all: torch==2.14.0+cpu --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU runtime install failed' }
& .runtime/kronos-venv/Scripts/python.exe -m pip install --only-binary=:all: -r kronos/requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Kronos dependency install failed' }
& .runtime/kronos-venv/Scripts/python.exe kronos/download.py
if ($LASTEXITCODE -ne 0) { throw 'Kronos model download failed' }
