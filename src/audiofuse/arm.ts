import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import streamDeck from "@elgato/streamdeck";

const run = promisify(exec);
const logger = streamDeck.logger.createScope("fuse-arm");

/**
 * Where Control Center installs. The 32-bit location is what the current
 * installer uses; the other is checked so a different build still works.
 */
const INSTALL_ROOTS = [
	"C:\\Program Files (x86)\\Arturia\\AudioFuse Control Center",
	"C:\\Program Files\\Arturia\\AudioFuse Control Center"
];

const GUI_NAME = "AudioFuse Control Center.exe";

/** Long enough for Control Center to start, arm the API and quit again. */
const RUN_TIMEOUT_MS = 120_000;

/** Nothing is gained by launching Control Center over and over. */
const COOLDOWN_MS = 5 * 60_000;

/**
 * Turns the HTTP API on by running Control Center for a moment.
 *
 * The agent that hosts the API is started at logon by a shortcut the installer
 * drops in the common Startup folder, but it never starts the HTTP server
 * itself. Whether the server runs is recorded in the agent's own
 * `resources\httpapi\config.json`, and the agent writes `enabled: false` there
 * as it shuts down - so every reboot leaves the flag off. The flag cannot
 * simply be set back on disk either: an agent that finds it already true at
 * startup exits immediately and resets it.
 *
 * Only the Control Center window turns the server on. It signals the agent that
 * is already running rather than starting its own - the agent keeps the same
 * pid across a launch - and the server then stays up inside the agent after the
 * window closes. That is why launching Control Center once after a reboot fixes
 * the plugin for the rest of the session, and why nothing else does.
 *
 * So that one launch is done here instead of by hand: Control Center is started,
 * its window is hidden the moment it appears, and it is closed again as soon as
 * the API answers, leaving the agent serving.
 *
 * Windows only. macOS publishes the API over DNS-SD and is not known to need
 * this, and the window handling below has no equivalent there.
 */
export class ControlCenterArmer {
	readonly #run: (command: string) => Promise<unknown>;
	readonly #cooldownMs: number;
	readonly #guiPath: string | undefined;
	readonly #now: () => number;

	#lastAttempt = Number.NEGATIVE_INFINITY;
	#busy = false;

	constructor(
		options: {
			run?: (command: string) => Promise<unknown>;
			cooldownMs?: number;
			platform?: NodeJS.Platform;
			exists?: (path: string) => boolean;
			now?: () => number;
		} = {}
	) {
		this.#run = options.run ?? ((command) => run(command, { windowsHide: true, timeout: RUN_TIMEOUT_MS }));
		this.#cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
		this.#now = options.now ?? Date.now;

		const platform = options.platform ?? process.platform;
		const exists = options.exists ?? existsSync;
		this.#guiPath =
			platform === "win32"
				? INSTALL_ROOTS.map((root) => `${root}\\${GUI_NAME}`).find((path) => exists(path))
				: undefined;
	}

	/** True when there is a Control Center on this machine that could be run. */
	get available(): boolean {
		return this.#guiPath !== undefined;
	}

	/**
	 * Runs Control Center once to turn the API on.
	 *
	 * @returns true if the API was serving by the time Control Center closed.
	 */
	async arm(): Promise<boolean> {
		if (!this.available || this.#busy) return false;

		// The user may simply not have an AudioFuse plugged in, in which case
		// this will fail every time; the cooldown keeps that cheap and quiet.
		const now = this.#now();
		if (now - this.#lastAttempt < this.#cooldownMs) return false;
		this.#lastAttempt = now;

		this.#busy = true;
		try {
			logger.info("no API found; starting Control Center to turn it on");
			// -EncodedCommand takes UTF-16LE base64, which sidesteps every
			// quoting rule between cmd, PowerShell and the script itself.
			const encoded = Buffer.from(armScript(this.#guiPath!), "utf16le").toString("base64");
			await this.#run(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`);
			logger.info("Control Center turned the HTTP API on");
			return true;
		} catch (err) {
			// exec rejects on a non-zero exit, which is how the script reports
			// that the API never came up.
			logger.warn(`could not turn the HTTP API on: ${String(err)}`);
			return false;
		} finally {
			this.#busy = false;
		}
	}
}

/**
 * The PowerShell that does the work.
 *
 * Exits 0 once the API answers, non-zero otherwise.
 */
function armScript(guiPath: string): string {
	const root = guiPath.slice(0, guiPath.lastIndexOf("\\"));
	return `
$ErrorActionPreference = 'SilentlyContinue'
$gui   = '${guiPath.replace(/'/g, "''")}'
$root  = '${root.replace(/'/g, "''")}'
$agent = Join-Path $root 'AudioFuseControlCenterAgent.exe'
$cfg   = 'C:\\ProgramData\\Arturia\\AudioFuse Control Center\\resources\\httpapi\\config.json'

function Get-ApiPort {
    try { $c = Get-Content $cfg -Raw | ConvertFrom-Json; if ($c.port -as [int]) { return [int]$c.port } } catch { }
    return 60465
}
function Test-Api {
    $p = Get-ApiPort
    try { return [bool](Invoke-RestMethod "http://127.0.0.1:$p/api/v1/version" -TimeoutSec 2).version } catch { return $false }
}

if (Test-Api) { exit 0 }

Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;namespace Af{public static class Win{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}}'

# Control Center signals the agent rather than starting one, so the agent has
# to be up first. At logon the Startup shortcut normally sees to that.
if (-not (Get-Process AudioFuseControlCenterAgent -ErrorAction SilentlyContinue)) {
    Start-Process $agent -WorkingDirectory $root
    Start-Sleep -Seconds 5
}

$proc = Start-Process $gui -WorkingDirectory $root -PassThru
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(45)
$up = $false
while ((Get-Date) -lt $deadline) {
    foreach ($g in @(Get-Process 'AudioFuse Control Center' -ErrorAction SilentlyContinue)) {
        $g.Refresh()
        if ($g.MainWindowHandle -ne [IntPtr]::Zero) {
            # Remember it: hiding a window zeroes MainWindowHandle, and the
            # handle is the only way back to it afterwards.
            $hwnd = $g.MainWindowHandle
            [void][Af.Win]::ShowWindow($hwnd, 0)
        }
    }
    if (Test-Api) { $up = $true; break }
    Start-Sleep -Milliseconds 500
}

# The API is armed within a second or two of launch, long before Control Center
# has finished starting; a WM_CLOSE sent that early is dropped and the window
# would be left behind.
try { [void]$proc.WaitForInputIdle(15000) } catch { }
Start-Sleep -Seconds 2

foreach ($g in @(Get-Process 'AudioFuse Control Center' -ErrorAction SilentlyContinue)) {
    $g.Refresh()
    if ($g.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $g.MainWindowHandle }
    [void][Af.Win]::ShowWindow($hwnd, 0)
}
if ($hwnd -ne [IntPtr]::Zero) {
    # WM_CLOSE still reaches a hidden window, so Control Center exits cleanly
    # and saves its preferences rather than being killed.
    [void][Af.Win]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
foreach ($g in @(Get-Process 'AudioFuse Control Center' -ErrorAction SilentlyContinue)) { [void]$g.WaitForExit(15000) }
foreach ($g in @(Get-Process 'AudioFuse Control Center' -ErrorAction SilentlyContinue)) { Stop-Process -Id $g.Id -Force }

if (Test-Api) { exit 0 } else { exit 1 }
`;
}
