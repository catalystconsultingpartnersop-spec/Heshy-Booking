// Runs every test suite, in several timezones, and reports a single pass/fail.
//
//   node tests/run.mjs
//
// No dependencies and no install step: api/_lib/time.js is plain JS, and the handful of
// Vercel/Stripe imports that api/create-booking.js pulls in are stubbed by stub-loader.mjs
// so the real shipped source can be exercised directly.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, 'register-loader.mjs');

const SUITES = ['time.test.mjs', 'booking.test.mjs', 'browser.test.mjs', 'privacy.test.mjs', 'portal.test.mjs', 'errorlog.test.mjs', 'agent.test.mjs',
               'billing.test.mjs', 'billing-parity.test.mjs', 'stripecustomer.test.mjs', 'coupon.test.mjs', 'assessment.test.mjs', 'assessment-copy.test.mjs', 'strengths-save.test.mjs', 'strengths-invite.test.mjs', 'store.test.mjs', 'schema.test.mjs', 'backup.test.mjs', 'limits.test.mjs', 'privacy-notice.test.mjs', 'client-details.test.mjs', 'hardening.test.mjs', 'cancellation.test.mjs', 'files-webhook.test.mjs', 'portal-login.test.mjs', 'password.test.mjs', 'portal-auth.test.mjs'];
// The app is Eastern-time only, so every suite must give identical results no matter where
// the server or the viewer happens to be.
const ZONES = ['America/New_York', 'UTC', 'America/Chicago', 'America/Los_Angeles',
               'Asia/Jerusalem', 'Australia/Sydney', 'Europe/London', 'Pacific/Kiritimati'];

let totalPass = 0, totalFail = 0;
for (const zone of ZONES) {
  for (const suite of SUITES) {
    const r = spawnSync(process.execPath, ['--import', loader, join(here, suite)], {
      encoding: 'utf8',
      env: { ...process.env, TZ: zone }
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/(\d+) passed, (\d+) failed/);
    if (!m) {
      console.log(`FAILED TO RUN  ${suite}  [TZ=${zone}]\n${out}`);
      totalFail++;
      continue;
    }
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
    if (Number(m[2]) > 0) console.log(`FAIL  ${suite}  [TZ=${zone}]\n${out}`);
  }
}

console.log(`\n${totalPass} assertions passed, ${totalFail} failed` +
            `  (${SUITES.length} suites x ${ZONES.length} timezones)`);
process.exit(totalFail ? 1 : 0);
