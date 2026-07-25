# Windows logon and startup performance research

**Scope:** practical, low-risk ways to shorten or accurately measure the time
between an automatic Windows logon and a post-reboot VR recovery being ready to
launch its application stack. This is research only; it does not prescribe a
change to the recovery state machine.

## What to measure first

Do not reduce recovery waits based only on the visible desktop. Microsoft
defines the boot interval as ending when the desktop is reached **and startup
tasks have completed**. Services, drivers, and startup applications can still
be consuming CPU and storage after sign-in.

- Use Windows Performance Recorder (WPR) to capture one representative boot.
  Its Fast Startup scenario can force a reboot and the documented exercise
  recommends waiting five minutes after the reboot so recording can finish.
  Open the resulting ETL in Windows Performance Analyzer (WPA), apply the
  `FastStartup.wpaprofile`, then inspect the Regions of Interest timeline plus
  CPU and disk use by process. This identifies whether the recovery delay is
  Windows boot itself, a particular startup application, or storage/CPU
  contention. [Microsoft: WPR Fast Startup exercise](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/optimizing-performance-and-responsiveness-exercise-2)
  [Microsoft: WPA overview](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-analyzer)
- For a fully explicit boot trace workflow, WPR supports
  `wpr -boottrace -addboot ...`; the OS begins the configured autologger only
  after reboot, and `-stopboot` saves the trace. Use this on a planned test
  reboot, not every recovery. [Microsoft: WPR command-line boot tracing](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options)
- In WPA, look for high CPU and disk-I/O consumers on the critical path.
  Microsoft specifically calls out RunOnce applications and Explorer
  initialization as potential I/O delays in Fast Startup. [Microsoft: CPU analysis and critical-path investigation](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/cpu-analysis)

## Safe candidates to reduce boot contention

1. **Audit nonessential startup applications, one at a time.** Task Manager's
   Startup tab lets the user disable entries and reports their measured startup
   impact. Microsoft classifies an entry as high impact at more than one second
   CPU time or more than 3 MB disk I/O during startup. Disable only applications
   that are not needed for the recovery path, then retest; do not remove drivers,
   security software, or required headset/audio software blindly.
   [Microsoft: Desktop Startup apps](https://learn.microsoft.com/en-us/windows/compatibility/startup-apps)
2. **Avoid competing automatic Steam startup if RWU already owns Steam
   readiness.** Valve documents the `Run Steam when my computer starts`
   Interface setting. Turning that off means RWU can launch Steam once at its
   deliberate point in the recovery sequence, avoiding a race and redundant
   early boot work. Validate that the account is still remembered by Steam before
   relying on this.
   [Valve Steam Support: startup setting](https://help.steampowered.com/en/faqs/view/6089-6768-F7FB-C46F)
3. **Do not use an idle condition as a generic "boot finished" signal.** Task
   Scheduler's definition of idle depends on sustained lack of input and low CPU
   and disk utilization; it can delay work unpredictably. An explicit readiness
   probe (RWU online, Matrix/VBAN reply, Steam ready) is more deterministic for
   a recovery flow.
   [Microsoft: Task Scheduler idle conditions](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-idle-conditions)

## Scheduled-task placement and reliability

- A task can trigger at user logon or system startup. A logon trigger can be
  bound to a particular user; that is appropriate for an application which must
  run in the interactive autologon desktop session. [Microsoft: scheduled-task
  triggers](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)
  [Microsoft: logon trigger example](https://learn.microsoft.com/en-us/windows/win32/taskschd/logon-trigger-example--scripting-)
- Task Scheduler also supports a deliberate `LogonTrigger.Delay`, expressed as
  a duration such as `PT30S`. This is useful only to defer *nonessential*
  background work so it cannot contend with RWU/Steam during the early recovery
  window. It should not replace application-specific readiness checks.
  [Microsoft: LogonTrigger.Delay](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger-delay)
- Do not use `Run`/`RunOnce` or Startup-folder ordering as a recovery timing
  guarantee: Windows documents that it may defer those programs to avoid
  interfering with foreground startup work, and their ordering is indeterminate.
  Inspect the actual RWU scheduled-task XML and Conditions tab for a hidden
  `LogonTrigger.Delay`; for an at-startup task, inspect `BootTrigger.Delay` as
  well. [Microsoft: Run and RunOnce Registry Keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)
  [Microsoft: BootTrigger.Delay](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger-delay)
- Inspect task conditions before treating a delay as an application problem.
  `RunOnlyIfIdle`, `RunOnlyIfNetworkAvailable`, AC/battery restrictions, and
  related settings can block or defer a task. `StartWhenAvailable` applies only
  to time-triggered tasks, so it does not make a missed logon trigger reliable.
  [Microsoft: TaskSettings](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings)
  [Microsoft: StartWhenAvailable](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-startwhenavailable-settingstype-element)
- Therefore, keep RWU as the early interactive logon task, but move unrelated
  personal/background tasks later (or disable them if unneeded). Keep recovery
  launch gates based on observed readiness instead of a fixed global desktop
  sleep. This preserves reliability while allowing measured reductions to the
  current conservative settle delay.

## Proposed experiment sequence

1. Record the current timeline from the recovery's own logs: reboot issued,
   RWU online/MQTT connected, Matrix healthy, Steam ready, SteamVR ready,
   OyasumiVR ready, VRChat/rejoin ready.
2. Capture one WPR Fast Startup trace for the same scenario and identify the
   largest CPU, disk, service, and startup-app contributors before the recovery
   begins its app launches.
3. Disable or defer only measured nonessential startup entries; retest at least
   two hard recoveries to distinguish normal boot variance from an improvement.
4. Only then lower the recovery's desktop-settle timer, in small increments,
   while retaining per-dependency readiness checks and timeouts.

## Important boundary

Autologon is required for an interactive desktop task but is not itself a boot
performance tuning control. Microsoft notes that autologon introduces physical
access risk; this machine should remain physically secured.
[Microsoft: Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)
