# Agent Instructions

## Deployment

RaphiiWinUtils normally deploys from Git. Do not replace its updater with manual copying just because
an update takes a while.

For a normal change:

1. Commit and push `main` only when the user has requested it.
2. Let the installed pre-push watcher request one update check. If needed, call `POST /update/check`
   once; do not repeatedly trigger it.
3. Wait for `%APPDATA%\RaphiiWinUtils\logs\update-YYYY-MM-DD.log` to contain
   `Update handoff complete` for the pushed revision.
4. Confirm `C:\Tools\RaphiiWinUtils\.deployed-revision` matches `origin/main` and the scheduled task is
   running before declaring deployment successful or failed.

The updater builds before stopping the running process, so several quiet minutes are not a failure.
Treat the update as failed only when the updater logs an error, exceeds its configured command timeout,
or finishes without deploying the pushed revision.

Use `npm run install:local` only for initial installation or when the user explicitly wants temporary
dirty-tree testing. A temporary local test must not be mistaken for the final deployment: after the
change is pushed, restore the normal installed task and let the Git updater deploy the committed
revision. Never introduce a persistent local-deployment pin.

Do not manually copy files into `C:\Tools\RaphiiWinUtils` during a normal Git update. If the updater is
actually broken, diagnose and fix the updater rather than bypassing it.
