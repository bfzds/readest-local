# Portable build settings wipe

> Date: 2026-08-11

## Symptom

After repacking the portable build, reader font settings (and other
preferences) reset to defaults.

## Root cause

`apps/readest-app/scripts/build-portable.ps1` unconditionally wrote
`settings.json` as `{}` in the portable output directory on every run.
Portable mode stores settings next to the exe, so repacking wiped the
user's settings; on the next launch the app wrote defaults back.

## Fix

Create the portable-mode marker only when `settings.json` does not already
exist. Existing user data is preserved across repacks.

## Test

`apps/readest-app/scripts/tests/build-portable.test.ps1` creates a temp
portable directory with a non-empty `settings.json`, runs the script, and
asserts the file is preserved. It failed before the fix and passes after.

## Recovery

Settings already wiped by previous repacks are not restored by this fix.
Restore them from a library backup zip or an older copy of the portable
folder.
