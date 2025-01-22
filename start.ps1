# Set encoding and error handling
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $scriptPath "index.js"

function Stop-Bot {
	param (
	    [Parameter(Mandatory=$true)]
	    [int]$ProcessId
	)
	
	# Send one SIGINT signal and wait for graceful shutdown
	Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Sending SIGINT signal..."
	taskkill /PID $ProcessId /F
	
	# Wait up to 30 seconds for the process to finish its tasks
	Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting 30 seconds for process to complete pending tasks..."
	$waitTime = 30
	while ($waitTime -gt 0) {
	    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
	        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot stopped successfully"
	        return $true
	    }
	    Start-Sleep -Seconds 1
	    $waitTime--
	}
	
	# If process is still running after 30 seconds, force kill it
	if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
	    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Process still running, forcing termination..."
	    Stop-Process -Id $ProcessId -Force
	    Start-Sleep -Seconds 2
	}
	
	return (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

while ($true) {
	try {
	    # Start Bot
	    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting Discord Bot..."
	    $process = Start-Process node -ArgumentList $indexPath -PassThru -WindowStyle Normal
	    
	    # Wait for 4 hours
	    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot started with PID: $($process.Id)"
	    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting 4 hours before restart..."
	    Start-Sleep -Seconds (4 * 60 * 60)
	    
	    # Stop Bot
	    if (Stop-Bot -ProcessId $process.Id) {
	        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting 5 seconds before restart..."
	        Start-Sleep -Seconds 5
	    } else {
	        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Warning: Process may not be fully stopped"
	        Start-Sleep -Seconds 10
	    }
	}
	catch {
	    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Error occurred: $_"
	    Start-Sleep -Seconds 30
	}
} 