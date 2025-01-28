# Set encoding and error handling
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

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

function Build-TypeScript {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Building TypeScript files..."
    $buildProcess = Start-Process cmd -ArgumentList "/c npm run build" -PassThru -NoNewWindow -Wait -WorkingDirectory $scriptPath
    if ($buildProcess.ExitCode -ne 0) {
        throw "TypeScript build failed with exit code $($buildProcess.ExitCode)"
    }
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] TypeScript build completed successfully"
}

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
      
      # Wait for 4 hours
      Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot started with PID: $($process.Id)"
      Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Waiting 6 hours before restart..."
      Start-Sleep -Seconds (6 * 60 * 60)
      
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
      Write-Host $_.Exception.Message
      Write-Host $_.ScriptStackTrace
      Start-Sleep -Seconds 30
  }
} 