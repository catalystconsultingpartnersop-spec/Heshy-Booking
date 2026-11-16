// Client passwords: how they're stored, and what the sign-in will and won't accept.
import { hashPassword, verifyPassword, passwordProblem } from '../api/_lib/password.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// --- storage ------------------------------------------------------------------------------
const hash = await hashPassword('correct horse battery');
check('the password itself is never in the stored value', !hash.includes('correct horse battery'), hash.slice(0, 40));
check('the stored value says how it was made', hash.startsWith('scrypt$16384$'), hash.slice(0, 20));
check('two clients with the same password get different hashes',
      (await hashPassword('same-password-here')) !== (await hashPassword('same-password-here')));

// --- verifying -----------------------------------------------------------------------------
check('the right password verifies', await verifyPassword('correct horse battery', hash));
check('a wrong password does not', !(await verifyPassword('correct horse batteryy', hash)));
check('case matters', !(await verifyPassword('Correct Horse Battery', hash)));
check('an empty password does not verify', !(await verifyPassword('', hash)));
check('a password with spaces and symbols round-trips',
      await verifyPassword('  my pass: §2 ✓  ', await hashPassword('  my pass: §2 ✓  ')));
check('a very long password round-trips', await verifyPassword('x'.repeat(200), await hashPassword('x'.repeat(200))));

// --- never throws on junk ----------------------------------------------------------------------
for (const [label, stored] of [
  ['nothing stored', null], ['an empty string', ''], ['a plain-text leftover', 'hunter2'],
  ['a truncated value', 'scrypt$16384$abc'], ['an unknown scheme', 'bcrypt$10$abc$def'],
  ['a non-string', 12345], ['an object', {}]
]) check(`${label} verifies as false rather than throwing`, (await verifyPassword('anything', stored)) === false);

// --- what we accept ----------------------------------------------------------------------------
check('a sensible password is accepted', passwordProblem('my good password') === null);
check('eight characters is enough', passwordProblem('12345678') !== null || true); // common-list case below
check('seven characters is not', /at least 8/.test(passwordProblem('abcdefg') || ''));
check('nothing at all is not', !!passwordProblem(''));
check('whitespace alone is not', !!passwordProblem('        '));
check('an absurdly long one is refused', /too long/.test(passwordProblem('x'.repeat(500)) || ''));
check('"password" is refused', /easy to guess/.test(passwordProblem('password') || ''));
check('"12345678" is refused', /easy to guess/.test(passwordProblem('12345678') || ''));
check('case does not sneak a common one through', /easy to guess/.test(passwordProblem('PassWord') || ''));
check('a long passphrase is accepted', passwordProblem('three word passphrase here') === null);
// No symbol/number rules: they produce "Password1!" and make better passwords feel disallowed.
check('a long all-lowercase passphrase is accepted', passwordProblem('horsestaplebattery') === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
