# Tauri Updater signing key backup and rotation

This document describes a safe backup and rotation process for the Tauri updater signing key used by CornerBrand.

## Scope and rules

- This procedure covers only updater signing key operations.
- Never store private key or password values in source control, issues, PR comments, chat logs, or screenshots.
- GitHub Releases updater metadata endpoint must stay:
  - `https://github.com/RepentanceHeaven/CornerBrand/releases/latest/download/latest.json`

## Required secrets (GitHub Actions)

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (only if the key is password-protected)

These secret names are fixed and should not contain whitespace or additional suffixes.

## Backup procedure (no secret exposure)

1. Confirm the current key is used for signing successful release artifacts (`latest.json` and `.sig`).
2. Ensure a secure offline backup exists for:
   - updater private key file
   - key password (if set)
3. Store backup materials in approved secure storage (for example: encrypted password manager + encrypted offline media) with two trusted maintainers able to recover.
4. Record key metadata only (creation date, owner, last rotation date, storage location reference) in an internal runbook.
5. Verify recovery path by having a maintainer confirm they can retrieve the key from backup without exposing the key in plaintext channels.

## Rotation procedure

1. Create a new updater key pair in a secure local environment.
2. Immediately place the new key and password (if any) into the same approved backup storage used above.
3. Update repository secrets:
   - set `TAURI_SIGNING_PRIVATE_KEY` to the new private key value
   - set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the new password value (or clear only if the new key has no password)
4. Trigger a new tagged release and confirm:
   - GitHub Release is published successfully
   - `latest.json` is reachable from `.../releases/latest/download/latest.json`
   - updater signature verification succeeds for the newly published artifacts
5. Keep the previous key available only for rollback window; after validation period, revoke and securely destroy deprecated key material according to policy.

## Incident response notes

- If key compromise is suspected, rotate immediately.
- Treat compromise as a release trust incident: pause releases, rotate key, publish a fresh signed release, and notify maintainers.

## Audit checklist

- Secrets present in repo settings with correct names.
- No private key or password content committed to repository.
- Backup location and recovery owners documented internally.
- Last successful release signed by the expected active key.
