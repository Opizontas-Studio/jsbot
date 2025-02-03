# Set encoding and error handling
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

function Stop-Bot {
    param (
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )
    
    # 首先尝试正常终止
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Attempting graceful shutdown..."
    Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
    
    # 等待10秒看是否正常关闭
    $waitTime = 10
    while ($waitTime -gt 0) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot stopped gracefully"
            return $true
        }
        Start-Sleep -Seconds 1
        $waitTime--
    }
    
    # 如果还在运行，使用taskkill强制终止
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Forcing termination..."
        taskkill /PID $ProcessId /F
        Start-Sleep -Seconds 5
    }
    
    return (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Build-TypeScript {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Building TypeScript files..."
    $buildProcess = Start-Process cmd -ArgumentList "/c pnpm run build" -PassThru -NoNewWindow -Wait -WorkingDirectory $scriptPath
    if ($buildProcess.ExitCode -ne 0) {
        throw "TypeScript build failed with exit code $($buildProcess.ExitCode)"
    }
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] TypeScript build completed successfully"
}

# 定义重启间隔时间（小时）
$restartInterval = 1

while ($true) {
    try {
        # Change to script directory
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Changing to script directory..."
        Set-Location -Path $scriptPath
      
        # Build TypeScript files
        Build-TypeScript
      
        # Start Bot using the compiled JavaScript
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting Discord Bot..."
        $nodePath = (Get-Command node).Source
        $process = Start-Process $nodePath -ArgumentList "dist/index.js" -PassThru -WindowStyle Normal -WorkingDirectory $scriptPath
      
        # Wait for 6 hours
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot started with PID: $($process.Id)"
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting $restartInterval hours before restart..."
        Start-Sleep -Seconds ($restartInterval * 60 * 60)
      
        # Stop Bot
        if (Stop-Bot -ProcessId $process.Id) {
            Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting 5 seconds before restart..."
            Start-Sleep -Seconds 5
        }
        else {
            Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Warning: Process may not be fully stopped"
            Start-Sleep -Seconds 5
        }
    }
    catch {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Error occurred: $_"
        Write-Host $_.Exception.Message
        Write-Host $_.ScriptStackTrace
        Start-Sleep -Seconds 15
    }
} 