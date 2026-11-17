// Editing a weekly pattern in place. Until now the only way to change one was to delete it and
// build a new one, which loses its identity and is easy to get wrong.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

check('each pattern has an Edit button', /data-edit-rule="\$\{r\.id\}"/.test(html));
check('...wired up', /querySelectorAll\('\[data-edit-rule\]'\)/.test(html));
check('editing loads the pattern into the form', /function startEditRule\(id\)/.test(html));
check('...including its days, times and address', /generalArea: rule\.generalArea\|\|''/.test(html));
check('...and opens the editor if it was closed', /showScheduleEditor = true;/.test(html));

check('saving an edit keeps the same rule, rather than replacing it',
      /if\(editingRuleId\)\{[\s\S]{0,400}?find\(r=>r\.id===editingRuleId\)/.test(html));
check('...and does not push a new one', !/if\(editingRuleId\)[\s\S]{0,400}?push\(rule\)/.test(html));
check('the button says Save changes while editing', /editingRuleId\?'Save changes':'Add pattern'/.test(html));
check('there is a way out without saving', /id="cancelEditRuleBtn"/.test(html) && /function cancelEditRule\(\)/.test(html));
check('clicking Edit again closes it', /if\(editingRuleId === id\)\{ cancelEditRule\(\); return; \}/.test(html));
check('the pattern being edited is marked in the list', /editing below/.test(html));

// Two things that would quietly corrupt the schedule.
check('switching between Online and In person abandons an open edit',
      /if\(editingRuleId\) cancelEditRule\(\); else render\(\);/.test(html));
check('a pattern that ends before it starts is refused',
      /newRule\.start >= newRule\.end[\s\S]{0,120}?return;/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
