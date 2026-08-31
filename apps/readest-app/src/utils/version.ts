import semver from 'semver';
import packageJson from '../../package.json';

// The fork overrides the reported app version at build time via
// NEXT_PUBLIC_APP_VERSION (set by .github/workflows/android-fork-build.yml,
// derived from the release tag). This lets the fork run a version that sorts
// higher than upstream's current release WITHOUT editing package.json, so
// future upstream syncs don't create a version conflict on every merge. When
// the env var is unset (e.g. plain `pnpm dev`), it falls back to package.json.
const FORK_APP_VERSION = process.env['NEXT_PUBLIC_APP_VERSION'] ?? packageJson.version;

export const getAppVersion = () => FORK_APP_VERSION;

export interface ParsedUpdateVersion {
  base: string; // "X.Y.Z"
  stamp: number | null; // YYYYMMDDHH, or null when not a nightly
  isNightly: boolean;
}

// A nightly version is `<base>-<YYYYMMDDHH>`: a single, pure-10-digit
// prerelease identifier. Anything else (e.g. `-rc.1`, `-2026`) is treated as a
// non-nightly base version.
export const parseUpdateVersion = (version: string): ParsedUpdateVersion | null => {
  const parsed = semver.parse(version);
  if (!parsed) return null;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  let stamp: number | null = null;
  if (parsed.prerelease.length === 1) {
    const id = String(parsed.prerelease[0]);
    if (/^\d{10}$/.test(id)) {
      stamp = Number(id);
    }
  }
  return { base, stamp, isNightly: stamp !== null };
};

// Base-aware "is candidate newer than current?" used by both the nightly channel
// check and (mirrored in Rust) the Tauri updater version_comparator.
// Rule: higher X.Y.Z core wins; on equal core a nightly outranks the matching
// stable (it was built after it) but never the reverse; two nightlies compare by
// stamp.
export const isUpdateNewer = (candidate: string, current: string): boolean => {
  const c = parseUpdateVersion(candidate);
  const cur = parseUpdateVersion(current);
  if (!c || !cur) return false;
  if (c.base !== cur.base) {
    return semver.compare(c.base, cur.base) > 0;
  }
  if (c.isNightly && !cur.isNightly) return true;
  if (!c.isNightly && cur.isNightly) return false;
  if (c.isNightly && cur.isNightly) return (c.stamp as number) > (cur.stamp as number);
  return false;
};
