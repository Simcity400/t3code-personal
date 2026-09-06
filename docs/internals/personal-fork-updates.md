# Personal fork updates

The installed app has one updater: the normal desktop release feed. The former
source-checkout updater, its git reset/build recovery state, IPC methods and UI
have been removed. Source developers use normal repository tooling explicitly.

Fork Sync checks official GitHub nightly releases every 15 minutes. It merges the
published tag, not the moving upstream main branch. `fork-upstream.json` records
the integrated tag and commit; source package versions remain upstream-owned.
Personal versions are stamped only in the release build. This removes recurring
version-pin conflicts and keeps unpublished upstream changes out of nightly syncs.

The gate separately compares the latest personal desktop release's commit with
main for release-relevant changes, so failed publication is retried even after a successful
integration without rebuilding documentation-only commits. An incomplete visible release
also triggers recovery, even if it names the current main commit. GitHub
may delay scheduled jobs, and compilation/publication takes additional time.
Real code conflicts stop the sync. They cannot be safely resolved by always taking
either side without losing fork features or upstream fixes. A stopped run publishes a
`needs-merge-help` branch holding `fork-sync-status.json` (the blocked tag, its
conflicting paths or the failure reason, and the run URL). The desktop updater reads
that file with the private-feed token on every update check and the sidebar shows an
"Official update needs a merge" notice whose button opens a new thread with the merge
prompt already written. The next successful sync deletes the branch, which clears the
notice; a successful build then reaches the normal installed-app update button.

## Finishing a blocked sync

This is the recipe the notice's prompt points at. Work in a clean worktree of the
fork with its `main` checked out and current.

1. Fetch the blocked tag from the official repository and merge it without committing:
   `git fetch --no-tags https://github.com/pingdotgg/t3code.git refs/tags/<tag>` then
   `git merge --no-commit --no-ff FETCH_HEAD`.
2. Delete upstream-only workflows inside the merge (`git rm` everything under
   `.github/workflows` except `fork-sync.yml`, `fork-release.yml` and
   `fork-mobile-preview.yml`). The fork's three workflows must come through the merge
   unchanged: CI's later pushes cannot touch workflow files.
3. Resolve each conflict so both sides survive: upstream's fix plus the fork
   customization MY-FORK.md describes for that area. When the fork retired a feature
   on purpose, drop upstream's additions to it rather than reviving it.
4. Take upstream's `pnpm-lock.yaml` and run `vp i`; the fork's manifest differences
   re-resolve into it.
5. Typecheck every package the merge touched and run the tests for the files you
   resolved by hand. Hand-resolved code has never compiled; expect dropped
   definitions and stubs behind new interfaces, and fix them rather than skipping.
6. Write the tag and its commit to `fork-upstream.json`, commit as
   `chore(fork): sync <tag>`, get a review pass, and push `main`. Fork Sync's next
   check sees a current main, clears the marker, and builds the release.

The release workflow runs focused fork regression tests and requires both Windows
architectures. Assets upload into a draft with prerelease disabled, because authenticated
private feeds can see drafts. The final publication enables prerelease and clears draft
together; both installers, both blockmaps and both
update manifests must exist with nonzero size before the release becomes visible.
The desktop updater selects the matching installer during the
supported-update check, before electron-updater caches metadata or downloads it.
This is necessary because NSIS picks the first executable in a multi-file manifest;
it does not select by architecture. A missing matching installer fails the check.
On Windows, Electron's `app.runningUnderARM64Translation` selects ARM64 even when
an earlier update left the app running as x64 under emulation. Native x64 hosts
continue to select x64. The shared private GitHub manifest remains compatible with
the existing feed.

An older installed updater cannot receive this selection fix before downloading
its first corrected build. An ARM user may therefore need to install that first
corrected ARM release manually once. Subsequent corrected releases preserve the
native host architecture. Publishing or installing builds is separate from editing
and validating the pipeline.

The largest remaining maintenance risk is fork behavior embedded in upstream's
chat/composer, provider ingestion and large activity-fold files. Keep shared domain
rules in client-runtime, native protocol differences in adapters, and surface UI
thin. A durable agent projection is the useful next architecture change: roster
identity and status should not depend indefinitely on replaying a bounded work log.
It needs a replay/backfill migration and should be implemented as its own change.
Splitting those files without changing ownership of state would only move complexity.
