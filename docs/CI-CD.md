# Automatic staging deploys

Push to `staging` and it deploys. GitHub Actions opens an SSH session to the
Lightsail instance, resets it to the pushed commit, rebuilds the stack, waits
for the API to report ready, and announces the result in Discord.

The workflow lives at [`.github/workflows/staging-deploy.yml`](../.github/workflows/staging-deploy.yml).
For the one-time server setup this builds on, see [DEPLOY.md](DEPLOY.md).

```
push to staging  ──►  deploy  ──►  notify
                        │
                        ├─ ssh to the box
                        ├─ git reset --hard <sha>
                        ├─ compose up -d --build   (migrate runs first)
                        └─ poll /health/ready until 200, up to 5 min
```

---

## It runs no tests, and that is a decision

Nothing in this pipeline stops a commit that fails `npm test` or
`npm run test:int` from reaching staging. It will deploy it and report success,
because the only check left is the readiness probe — and a wrong build still
starts. The probe catches a stack that **will not boot**. It cannot catch one
that boots and is wrong.

So running them before you push is not optional:

```bash
npm run typecheck && npm test && npm run test:int
```

### Putting the test jobs back

Add two jobs and make `deploy` need both:

```yaml
  verify:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: nutricheck-api      # ON THE JOB — see below
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.14.0'              # matches the Dockerfile
          cache: npm
          cache-dependency-path: nutricheck-api/package-lock.json
      - run: npm ci --workspaces --include-workspace-root --no-audit --no-fund
      - run: npm run typecheck
      - run: npm test

  integration:
    # same setup, then:
      - run: npm run build                     # REQUIRED — see below
      - run: npm run test:int
```

Two things that cost real time to discover:

**`working-directory` belongs on the job, never workflow-wide.** The `deploy`
job never checks the repository out. A `defaults.run.working-directory` at the
top of the file applies to every job, so each of `deploy`'s steps fails on a
path that does not exist — and it stays hidden for as long as an earlier job
keeps failing first.

**`npm run build` must precede `test:int`.** `foods-search.int-spec.ts` imports
`@nutricheck/ingest`, which `apps/api/package.json` does not declare. It
resolves anyway through the workspace symlink npm drops in root `node_modules`,
so the import succeeds while that package's own `dist/` is missing, and `tsc`
fails with TS2307 on a package sitting right there. Turbo cannot help: `test:int`
declares `dependsOn: ["^build"]`, and `^build` means *the declared dependencies
of this package*. An undeclared one is invisible to the task graph.

Building the whole workspace fixes the symptom. The cause is the missing
declaration, and fixing it properly means adding `@nutricheck/ingest` to
`apps/api` devDependencies **and** copying `tools/ingest/package.json` in the
Dockerfile's `deps` stage — the image currently copies only `apps/api`,
`packages/contracts` and `packages/database` manifests, so declaring the
dependency alone would trade a broken CI job for a broken image build.

This class of failure never appears locally: `tools/ingest/dist` is already on
disk from an earlier build. CI is the only machine that starts from nothing,
which is the entire reason it is worth having.

---

## Required secrets

**Settings → Secrets and variables → Actions**

| Secret | Value | Notes |
|---|---|---|
| `STAGING_SSH_KEY` | private key, `-----BEGIN` through `-----END-----` | dedicated deploy key, not the Lightsail default |
| `STAGING_HOST` | `3.6.120.121` | the **static** IP |
| `STAGING_USER` | `ubuntu` | |
| `STAGING_URL` | `https://3-6-120-121.sslip.io` | used by the readiness poll |
| `DISCORD_WEBHOOK` | the webhook URL | a credential; anyone holding it can post |

### Generating the deploy key

On the box:

```bash
ssh-keygen -t ed25519 -C "github-actions-staging" -f ~/.ssh/gha_deploy -N ""
cat ~/.ssh/gha_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/gha_deploy          # copy this into STAGING_SSH_KEY
rm ~/.ssh/gha_deploy           # then delete it
```

That last line matters. The private key grants access *to* this machine, so it
has no business living *on* it.

Use a key dedicated to Actions rather than the Lightsail default: the default
opens every instance in the account, and this one should open exactly one.

---

## Design notes

**`git reset --hard <sha>`, not `git pull`.** The box must end up at exactly the
commit that was pushed. A merge conflict on a deploy target at 3am is not a
deployment strategy. `.env.staging` is gitignored and survives the reset.

**Gated on `/health/ready`, never `/health/live`.** Liveness deliberately checks
no dependency — a liveness probe that touched the database would restart every
replica during a database blip. So it returns 200 from an API that cannot reach
Postgres at all. A deploy gated on liveness reports success for a release that
fails every query, which is precisely how a TLS misconfiguration reached a
running staging box during the first deploy.

**The image builds on the server.** Building in the runner and shipping through
a registry is the more scalable shape, but it needs registry credentials living
on the instance and buys little at ~95 seconds a build. Switch when rollback
needs to be instant — redeploy tag N-1 rather than rebuild commit N-1 — by
pushing to GHCR and setting `IMAGE=` in `.env.staging`, which
`docker-compose.staging.yml` already reads.

**`concurrency` without `cancel-in-progress`.** Two deploys must never touch the
box at once, but cancelling one midway through `compose up` leaves a half-swapped
stack. Waiting is the lesser problem.

**No `url:` under `environment`.** The `secrets` context is not available there —
only `github`, `vars`, `needs`, `env` and a few others. An unavailable context
does not render blank; it invalidates the **entire workflow file**, so nothing
runs and the Actions tab shows an empty list rather than an error. To get the
clickable link on the deployment, move `STAGING_URL` to a repository *variable*
and use `${{ vars.STAGING_URL }}`. It is a public hostname, not a secret.

---

## Discord notifications

Posted on `always()`, so a failed deploy is announced rather than silently
absent. A notifier that only fires on success reports the runs nobody needed
telling about and goes quiet for the one that matters.

| Colour | Meaning |
|---|---|
| Green | deployed, and `/health/ready` returned 200 |
| Red | deploy ran and failed |

The payload is assembled with `jq --arg`, not a shell template. A commit message
containing a quote, a newline or a backslash would otherwise produce invalid
JSON, and the notification would vanish exactly when the commit was unusual
enough to be worth reading about.

A missing `DISCORD_WEBHOOK` skips the step rather than failing it — a fork has
no reason to hold the secret, and failing someone's run over a notification is
the reporting breaking the thing it reports on.

---

## When a deploy fails

The workflow SSHes back in and prints `compose ps`, the migrate log, and api log
lines at **level 40/50** only. Read that step's output first — it usually
answers the question without anyone logging in.

Filter api logs by pino level, never by keyword. Every request line contains
`x-download-options`, so a grep for `down` matches all of them and buries the one
line that matters:

```bash
dc logs --tail=300 api | grep -E '"level":(40|50)' | tail -5
```

| Symptom | Cause |
|---|---|
| `Permission denied (publickey)` | `gha_deploy.pub` not in `~/.ssh/authorized_keys`, or `STAGING_SSH_KEY` missing its BEGIN/END lines |
| Readiness times out, containers running | check `/health/ready` by hand — usually `database: down` |
| `The server does not support SSL connections` | `DATABASE_SSL=false` missing from `.env.staging`; see [DEPLOY.md §8](DEPLOY.md) |
| Deploy succeeds, site unreachable | `DOMAIN` does not match the instance's current static IP |
| Build OOMs | swap missing — `free -h` should show 4 GiB |

### Nothing runs at all

An **invalid workflow file** produces a run that fails instantly with a parse
error — validating a file needs no runner, so that much always appears. If there
is no run *at all*, the workflow was never triggered:

- Is the branch right? `on.push.branches: [staging]` and nothing else deploys.
- Does a `paths-ignore` filter match every changed file in the push?
- Are Actions enabled — Settings → Actions → General?
- Are Actions minutes exhausted? Private repos draw on a monthly free tier, and
  running out blocks runner allocation without producing a run row.

Note that the sidebar on the Actions tab lists workflows found on the **default
branch**. A workflow that exists only on `staging` will not appear there, and
`workflow_dispatch` will not offer a "Run workflow" button, even though push
triggers work normally. That is a display quirk, not a fault.
