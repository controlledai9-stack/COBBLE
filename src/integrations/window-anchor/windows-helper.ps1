# Cobble Windows Native Helper for IDE Window Observation (COBBLE-WINDOW-01)
# Long-lived, hidden process communicating over stdin/stdout using newline-delimited JSON.
# ZERO external dependencies, reads ONLY OS window and process metadata.

param()

$ErrorActionPreference = 'SilentlyContinue'

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# C# P/Invoke definitions for Win32 User32 APIs
$nativeSource = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class CobbleNativeHelper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public class CandidateItem {
        public string WindowId;
        public int ProcessId;
        public string Title;
    }

    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    public static void Init() {
        try {
            // Attach thread to Default interactive desktop if running in an isolated sub-desktop
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
        } catch {}

        try {
            // Enable Per-Monitor v2 DPI awareness for true physical pixel bounds
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        } catch {}
    }

    public static List<CandidateItem> ListCandidates(int[] processIds) {
        var results = new List<CandidateItem>();
        var procSet = new HashSet<int>(processIds);

        EnumWindowsProc proc = (hWnd, lParam) => {
            uint targetPid;
            GetWindowThreadProcessId(hWnd, out targetPid);
            if (procSet.Contains((int)targetPid) && IsWindowVisible(hWnd)) {
                var sbTitle = new StringBuilder(1024);
                GetWindowText(hWnd, sbTitle, 1024);
                var sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                string title = sbTitle.ToString();
                string cls = sbClass.ToString();
                if (title.Length > 0 && cls == "Chrome_WidgetWin_1") {
                    results.Add(new CandidateItem {
                        WindowId = "0x" + hWnd.ToInt64().ToString("X"),
                        ProcessId = (int)targetPid,
                        Title = title
                    });
                }
            }
            return true;
        };

        IntPtr hDesk = OpenDesktop("Default", 0, false, 0x0041);
        if (hDesk != IntPtr.Zero) {
            EnumDesktopWindows(hDesk, proc, IntPtr.Zero);
            CloseDesktop(hDesk);
        } else {
            EnumWindows(proc, IntPtr.Zero);
        }

        return results;
    }
}
"@

Add-Type -TypeDefinition $nativeSource

# Initialize desktop attachment & Per-Monitor v2 DPI awareness
[CobbleNativeHelper]::Init()

function Get-EditorProcessNames([string]$editorKind) {
    switch ($editorKind.ToLower()) {
        'vscode' { return @('Code') }
        'cursor' { return @('Cursor') }
        'antigravity' { return @('Antigravity') }
        default { return @() }
    }
}

function Parse-WindowHandle([string]$rawId) {
    if ([string]::IsNullOrWhiteSpace($rawId)) { return [IntPtr]::Zero }
    try {
        if ($rawId.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {
            $val = [System.Convert]::ToInt64($rawId.Substring(2), 16)
            return [IntPtr]$val
        } else {
            $val = [System.Convert]::ToInt64($rawId, 10)
            return [IntPtr]$val
        }
    } catch {
        return [IntPtr]::Zero
    }
}

# Ready signal
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    try {
        $cmdObj = $line | ConvertFrom-Json
    } catch {
        [Console]::Out.WriteLine('{"type":"error","message":"Invalid JSON input"}')
        [Console]::Out.Flush()
        continue
    }

    $command = $cmdObj.cmd
    if ($command -eq 'exit') {
        break
    }

    if ($command -eq 'list') {
        $editor = [string]$cmdObj.editor
        $allowedProcNames = Get-EditorProcessNames $editor
        $candidates = @()

        if ($allowedProcNames.Count -gt 0) {
            $procs = Get-Process -Name $allowedProcNames -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
            if ($procs.Count -gt 0) {
                $rawList = [CobbleNativeHelper]::ListCandidates([int[]]$procs)
                foreach ($item in $rawList) {
                    $candidates += @{
                        windowId = $item.WindowId
                        processId = $item.ProcessId
                        editor = $editor
                        title = $item.Title
                    }
                }
            }
        }

        $res = @{
            type = 'candidates'
            candidates = $candidates
        }
        [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        continue
    }

    if ($command -eq 'inspect') {
        $windowIdStr = [string]$cmdObj.windowId
        $expectedPid = [int]$cmdObj.expectedPid
        $editor = [string]$cmdObj.editor
        $hWnd = Parse-WindowHandle $windowIdStr

        if ($hWnd -eq [IntPtr]::Zero -or -not [CobbleNativeHelper]::IsWindow($hWnd)) {
            $res = @{
                type = 'snapshot'
                found = $false
                reason = 'Window handle is invalid or closed'
            }
            [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            continue
        }

        $currentPid = 0
        [CobbleNativeHelper]::GetWindowThreadProcessId($hWnd, [ref]$currentPid) | Out-Null

        # Check PID match if expectedPid was specified
        if ($expectedPid -gt 0 -and $currentPid -ne $expectedPid) {
            $res = @{
                type = 'snapshot'
                found = $false
                reason = 'Process ID mismatch; window handle was recycled'
            }
            [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            continue
        }

        # Check process name match
        $procObj = Get-Process -Id $currentPid -ErrorAction SilentlyContinue
        if ($null -eq $procObj) {
            $res = @{
                type = 'snapshot'
                found = $false
                reason = 'Owner process has exited'
            }
            [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            continue
        }

        $allowedProcNames = Get-EditorProcessNames $editor
        if ($allowedProcNames.Count -gt 0 -and -not ($allowedProcNames -contains $procObj.ProcessName)) {
            $res = @{
                type = 'snapshot'
                found = $false
                reason = 'Process name mismatch; handle belongs to different application'
            }
            [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            continue
        }

        $isVisible = [CobbleNativeHelper]::IsWindowVisible($hWnd)
        $isIconic = [CobbleNativeHelper]::IsIconic($hWnd)
        $fgHwnd = [CobbleNativeHelper]::GetForegroundWindow()
        $isFocused = ($fgHwnd -eq $hWnd)

        $rect = New-Object CobbleNativeHelper+RECT
        [CobbleNativeHelper]::GetWindowRect($hWnd, [ref]$rect) | Out-Null

        $sbTitle = New-Object System.Text.StringBuilder 1024
        [CobbleNativeHelper]::GetWindowText($hWnd, $sbTitle, 1024) | Out-Null

        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top

        $res = @{
            type = 'snapshot'
            found = $true
            windowId = ('0x{0:X}' -f $hWnd.ToInt64())
            processId = [int]$currentPid
            editor = $editor
            title = $sbTitle.ToString()
            focused = [bool]$isFocused
            minimized = [bool]$isIconic
            visible = [bool]$isVisible
            boundsPhysical = @{
                x = [int]$rect.Left
                y = [int]$rect.Top
                width = [int]$width
                height = [int]$height
            }
        }

        [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        continue
    }

    [Console]::Out.WriteLine('{"type":"error","message":"Unknown command"}')
    [Console]::Out.Flush()
}
