[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OneCExe,

    [Parameter(Mandatory = $true)]
    [string]$ConfigurationSourceDir,

    [Parameter(Mandatory = $true)]
    [string]$ExtensionSourceDir,

    [Parameter(Mandatory = $true)]
    [string]$OutputCfePath,

    [Parameter(Mandatory = $true)]
    [string]$WorkDir,

    [string]$ExtensionName = "KOTFormExplorerRuntime",

    [switch]$RebuildBase
)

$ErrorActionPreference = "Stop"

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Remove-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-BaseConfigState {
    param([Parameter(Mandatory = $true)][string]$BaseConfigDir)

    $configurationXmlPath = Join-Path $BaseConfigDir "Configuration.xml"
    if (-not (Test-Path -LiteralPath $configurationXmlPath)) {
        throw "Configuration.xml not found at: $configurationXmlPath"
    }

    $configurationXml = Get-Item -LiteralPath $configurationXmlPath
    return [pscustomobject]@{
        configurationSourceDir = (Get-CanonicalPath -Path $BaseConfigDir)
        configurationXmlPath   = (Get-CanonicalPath -Path $configurationXmlPath)
        configurationXmlLength = $configurationXml.Length
        configurationXmlMtime  = $configurationXml.LastWriteTimeUtc.ToString("o")
    }
}

function Test-BaseConfigState {
    param(
        [Parameter(Mandatory = $true)][string]$StampPath,
        [Parameter(Mandatory = $true)]$ExpectedState
    )

    if (-not (Test-Path -LiteralPath $StampPath)) {
        return $false
    }

    try {
        $storedState = Get-Content -LiteralPath $StampPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }

    return (
        $storedState.configurationSourceDir -eq $ExpectedState.configurationSourceDir `
        -and $storedState.configurationXmlPath -eq $ExpectedState.configurationXmlPath `
        -and [string]$storedState.configurationXmlLength -eq [string]$ExpectedState.configurationXmlLength `
        -and $storedState.configurationXmlMtime -eq $ExpectedState.configurationXmlMtime
    )
}

function Save-BaseConfigState {
    param(
        [Parameter(Mandatory = $true)][string]$StampPath,
        [Parameter(Mandatory = $true)]$State
    )

    $State | ConvertTo-Json | Set-Content -LiteralPath $StampPath -Encoding UTF8
}

function Format-Command {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $quotedArguments = foreach ($argument in $Arguments) {
        '"' + $argument.Replace('"', '""') + '"'
    }

    return @('"' + $Executable.Replace('"', '""') + '"') + $quotedArguments -join ' '
}

function Invoke-OneCStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$LogPath
    )

    $effectiveArguments = $Arguments + @('/Out', $LogPath)
    Write-Host "Form Explorer build step: $Title"
    Write-Host ("Resolved 1C command: " + (Format-Command -Executable $OneCExe -Arguments $effectiveArguments))

    & $OneCExe @effectiveArguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        return
    }

    $tail = "<empty output>"
    if (Test-Path -LiteralPath $LogPath) {
        $tailLines = Get-Content -LiteralPath $LogPath -Tail 200 -ErrorAction SilentlyContinue
        if ($tailLines) {
            $tail = ($tailLines -join [Environment]::NewLine)
        }
    }

    throw "1C command for `"$Title`" exited with code $exitCode. Output tail: $tail"
}

if (-not (Test-Path -LiteralPath $OneCExe)) {
    throw "1cv8.exe not found at path: $OneCExe"
}

$resolvedWorkDir = if (Test-Path -LiteralPath $WorkDir) {
    Get-CanonicalPath -Path $WorkDir
} else {
    $WorkDir
}

$builderInfobaseDirectory = Join-Path $resolvedWorkDir "builder-infobase-cache"
$logsDirectory = Join-Path $resolvedWorkDir "build-logs"
$baseStatePath = Join-Path $resolvedWorkDir "builder-base-state.json"
$baseConfigState = Get-BaseConfigState -BaseConfigDir $ConfigurationSourceDir

Ensure-Directory -Path $resolvedWorkDir
Ensure-Directory -Path (Split-Path -Parent $OutputCfePath)
Remove-Directory -Path $logsDirectory
Ensure-Directory -Path $logsDirectory

$mustRebuildBase = $RebuildBase.IsPresent `
    -or -not (Test-Path -LiteralPath $builderInfobaseDirectory) `
    -or -not (Test-BaseConfigState -StampPath $baseStatePath -ExpectedState $baseConfigState)

if ($mustRebuildBase) {
    Write-Host "Rebuilding cached builder infobase."
    Remove-Directory -Path $builderInfobaseDirectory
    Ensure-Directory -Path $builderInfobaseDirectory

    Invoke-OneCStep `
        -Title "Create cached builder infobase" `
        -Arguments @('CREATEINFOBASE', "File=$builderInfobaseDirectory") `
        -LogPath (Join-Path $logsDirectory '01-create-builder-infobase.log')

    Invoke-OneCStep `
        -Title "Load base configuration into cached builder infobase" `
        -Arguments @(
            'DESIGNER',
            '/DisableStartupDialogs',
            '/DisableStartupMessages',
            '/IBConnectionString',
            "File=$builderInfobaseDirectory",
            '/LoadConfigFromFiles',
            $ConfigurationSourceDir,
            '/UpdateDBCfg'
        ) `
        -LogPath (Join-Path $logsDirectory '02-load-base-configuration.log')

    Save-BaseConfigState -StampPath $baseStatePath -State $baseConfigState
} else {
    Write-Host "Reusing cached builder infobase."
}

if (Test-Path -LiteralPath $OutputCfePath) {
    Remove-Item -LiteralPath $OutputCfePath -Force
}

Invoke-OneCStep `
    -Title "Load generated Form Explorer extension into cached builder infobase" `
    -Arguments @(
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        "File=$builderInfobaseDirectory",
        '/LoadConfigFromFiles',
        $ExtensionSourceDir,
        '-Extension',
        $ExtensionName,
        '/UpdateDBCfg'
    ) `
    -LogPath (Join-Path $logsDirectory '03-load-generated-extension.log')

Invoke-OneCStep `
    -Title "Dump generated Form Explorer extension to .cfe" `
    -Arguments @(
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/IBConnectionString',
        "File=$builderInfobaseDirectory",
        '/DumpCfg',
        $OutputCfePath,
        '-Extension',
        $ExtensionName
    ) `
    -LogPath (Join-Path $logsDirectory '04-dump-generated-extension.log')
