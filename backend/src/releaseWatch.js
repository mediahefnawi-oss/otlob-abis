'use strict';
/**
 * Announces a new app version by itself.
 * Every few minutes the server looks at the newest APK release on GitHub (the build-apk workflow publishes one per build),
 * reads the app version that build was made from (app.json at that release's tag) and, if it is newer than the announced
 * one, publishes the update notice that every user sees. The owner can still edit or withdraw the notice from the panel.
 */
const DEFAULT_MESSAGE = 'يتوفر تحديث جديد لتطبيق أطلب أبيس. حدّث التطبيق للحصول على آخر المميزات.';
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
};

/** One check. Returns 'same' | 'published' | 'noted' | 'skipped' (never throws). */
async function checkRelease({ pool, fetchFn = globalThis.fetch, repo, onChange = () => {} }) {
  try {
    if (!fetchFn || !repo) return 'skipped';
    const get = async (url, json) => {
      const r = await fetchFn(url, { headers: { 'User-Agent': 'otlob-abis-api', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return json ? r.json() : r.text();
    };
    const rel = await get(`https://api.github.com/repos/${repo}/releases/latest`, true);
    const tag = String(rel && rel.tag_name || '');
    if (!/^[\w.-]{1,64}$/.test(tag)) return 'skipped';
    const cur = (await pool.query('SELECT update_version, update_release_tag FROM app_settings WHERE id=1')).rows[0];
    if (!cur) return 'skipped';
    if (cur.update_release_tag === tag) return 'same';
    const app = JSON.parse(await get(`https://raw.githubusercontent.com/${repo}/${tag}/app.json`, false));
    const version = String(app && app.expo && app.expo.version || '');
    if (!VERSION_RE.test(version)) return 'skipped';
    if (!cur.update_version || cmp(version, cur.update_version) > 0) {
      await pool.query('UPDATE app_settings SET update_version=$1, update_message=$2, update_required=FALSE, update_release_tag=$3, updated_at=NOW() WHERE id=1', [version, DEFAULT_MESSAGE, tag]);
      onChange();
      return 'published';
    }
    await pool.query('UPDATE app_settings SET update_release_tag=$1 WHERE id=1', [tag]);
    return 'noted';
  } catch (e) {
    if (e && e.code !== '42703') console.warn('release check failed:', e.message);
    return 'skipped';
  }
}

function startReleaseWatch({ pool, onChange, repo = process.env.RELEASE_REPO || 'mediahefnawi-oss/otlob-abis', everyMs = 10 * 60 * 1000 }) {
  if (process.env.AUTO_UPDATE_NOTICE === 'off') return null;
  const run = () => checkRelease({ pool, repo, onChange }).then(r => { if (r === 'published') console.log('update notice published automatically'); });
  setTimeout(run, 45 * 1000).unref();
  const t = setInterval(run, everyMs); t.unref();
  return t;
}
module.exports = { checkRelease, startReleaseWatch, cmp };
