# Dependencies

`package-lock.json` is committed. Without it, every deploy resolved versions afresh, so two
builds of the same commit could ship different code, and `npm audit` had nothing to check.

## The @vercel/blob advisories

Adding the lockfile immediately surfaced advisories. They were looked at properly rather than
upgraded past, and the conclusion was to stay put. Recording why, so this isn't rediscovered and
churned later.

**On 0.27.x (what ships today):** 3 advisories — `undici` → `@fastify/busboy`, denial of service
and CRLF injection, both via **multipart request parsing**.

**On 2.9.0 (the suggested fix):** 4 advisories — `zod` memory exhaustion via oversized
collections, reached through `@vercel/oidc` → `@vercel/cli-config`.

So the upgrade trades three problems for four. npm's own `audit fix --force` then suggests
downgrading to 2.4.0, which reintroduces the first set.

**Neither set is reachable from this app.** Blob is used to `put` a Buffer and `del` a URL. The
app never parses multipart input through undici, and zod sits in Vercel's own config loading,
not on any request path.

Staying on 0.27.x is therefore the lower-risk choice: the advisories are equivalent in practice,
and the upgrade is a breaking change that cannot be fully verified without the real Blob service.

Worth revisiting when a release is clean on both counts.

## One thing the newer version would buy

@vercel/blob 2.x supports `access: 'private'`, which 0.27 does not. Uploaded files are currently
public-but-unguessable: 32 hex characters of real randomness in the path, which is not something
anyone searches their way to. Private blobs would be stronger — the file would require
authentication rather than relying on the URL staying secret.

That is a worthwhile change, but a larger one: every place that links to a stored file would have
to fetch it through an authenticated endpoint instead of linking straight at it. Not urgent, and
not something to do in passing.
