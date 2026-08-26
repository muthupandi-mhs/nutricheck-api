# Deploying the API to AWS Lightsail

A from-scratch deployment onto a single 4 GB Lightsail instance: Postgres,
Redis, the API, the worker, and Caddy for TLS, all on one box.

Everything here assumes the **$24/month Lightsail plan** — 2 vCPU, 4 GB RAM,
80 GB SSD, 4 TB transfer. A freshly seeded database is 26 MB and the whole runtime
footprint is about 2.7 GB, so that plan has real headroom. See §10 for when it stops being
enough.

---

## 0. Before you start

You need two things this guide cannot create for you:

1. **An AWS account** with Lightsail available.
2. **A domain name** you control, with access to its DNS records. Caddy gets a
   free Let's Encrypt certificate automatically, but only for a hostname that
   resolves to this server. Without a domain you can still run the stack, but
   the app will talk to it over plain HTTP on an IP address, which you should
   not ship to real users.

Have ready, from your laptop:

- `corpus-seed.sql.gz` — the 13,440-food corpus export (see §7 if you need to
  regenerate it)
- The SSH key Lightsail gives you when the instance is created

---

## 1. Create the instance

In the Lightsail console:

- **Region** — the one closest to your users. For an India-facing app,
  `ap-south-1` (Mumbai).
- **Platform** — Linux/Unix
- **Blueprint** — **OS Only → Ubuntu 24.04 LTS**

  Not the "Docker" blueprint. That one ships a Bitnami image with its own
  opinions about where things live, and it fights this setup rather than
  helping.
- **Plan** — the 4 GB / 2 vCPU / 80 GB one
- **Name** — `nutricheck-api`

Then attach a **static IP**: Networking → Create static IP → attach to the
instance. This is free while attached to a running instance. Skip it and the
public IP changes on every stop/start, which silently breaks both your DNS
record and every installed copy of the app.

## 2. Open the right ports, and only those

Networking → IPv4 Firewall. You want exactly:

| Application | Protocol | Port |
|---|---|---|
| SSH | TCP | 22 |
| HTTP | TCP | 80 |
| HTTPS | TCP | 443 |

**Port 80 is not optional** even though all real traffic is HTTPS — Let's
Encrypt's HTTP-01 challenge uses it, and certificate issuance fails without it.

**Never add 5432 or 6379.** The production compose file does not publish them,
so they are unreachable regardless, but adding a firewall rule for a port you
think you might want later is how a database ends up on Shodan.

## 3. Add swap

SSH in (`ssh -i yourkey.pem ubuntu@YOUR_STATIC_IP`), then:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Lightsail's Ubuntu images ship with **zero swap**. On 4 GB, the build step in §6
is the peak, and without swap the kernel's OOM killer resolves it by killing
Postgres. Swap is not there to run in — it is there so a spike doesn't take the
database with it.

## 4. Install Docker

Use Docker's own repository, not Ubuntu's `docker.io` package:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker
docker compose version
```

That last line **must report 2.24 or newer**. The compose files use the
`env_file: - path: … required:` object form, added in 2.24. An older Compose
fails with a confusing schema error that looks like a typo in the file.

## 5. Get the code and write the secrets

```bash
sudo apt-get update && sudo apt-get install -y git
git clone YOUR_REPO_URL nutricheck
cd nutricheck/nutricheck-api
cp .env.prod.example .env.prod
```

Generate the three secrets:

```bash
# Postgres password
openssl rand -base64 32 | tr -d '/+=' | head -c 40; echo

# Two DIFFERENT JWT secrets — run this twice
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

No Node on the box yet? `openssl rand -base64 48 | tr -d '/+='` gives an
equally good secret.

Then `nano .env.prod` and fill in `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `DOMAIN`, and `ACME_EMAIL`. Leave `ANTHROPIC_API_KEY` and
`GEMINI_API_KEY` blank for now if you like — the API boots without them and
only `/v1/resolve` and `/v1/transcribe` are disabled. M1 core is fully usable
with zero AI.

Reuse of one secret for both JWT values is a real vulnerability, not a style
point: it lets a stolen access token be replayed as a refresh token.

`.env.prod` is gitignored. Confirm before you ever commit from this box:

```bash
git check-ignore -v .env.prod   # must print a match
```

## 6. Point DNS at the server, then build

Add an **A record** for your domain to the static IP, and wait for it to
resolve. Check from the server:

```bash
dig +short api.yourdomain.com    # must print your static IP
```

Do this **before** starting the stack. Caddy requests a certificate on boot, and
Let's Encrypt rate-limits failed issuance to 5 per hostname per hour — a stack
started against DNS that isn't ready yet can lock you out of certificates for an
hour. (The Caddyfile has a commented-out staging CA line for exactly this
situation.)

Then build and start:

```bash
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d --build
```

The build takes **5–10 minutes** on 2 vCPU. It runs `npm ci` across the whole
workspace and `turbo run build`; this is the step swap exists for. Watch it with
`docker stats` in another session if you want to see how close it gets.

Migrations run automatically as a one-shot `migrate` service that must exit
cleanly before `api` and `worker` start. They deliberately never run on
application boot — two replicas booting at once would race each other.

### Building somewhere else instead

If you have a Docker Hub account, building on your laptop is faster and takes
all memory pressure off the server:

```bash
# on your laptop
docker build -f docker/Dockerfile --target runtime -t youruser/nutricheck-api:1.0.0 .
docker push youruser/nutricheck-api:1.0.0
```

Then set `IMAGE=docker.io/youruser/nutricheck-api:1.0.0` in `.env.prod` and drop
`--build` from the command above. One image serves api, worker, and migrate, so
there is only ever one artifact to promote.

## 7. Load the corpus

The ingest CLI **cannot run on the server** — `tools/` is not copied into the
runtime image, and `tsx` is a devDependency that `npm prune --omit=dev` removes.
Restoring a dump is the intended path, and it is also the cheaper one: 2.3 MB
transferred instead of a 9 MB download plus CSV parsing.

From your laptop:

```bash
scp -i yourkey.pem corpus-seed.sql.gz ubuntu@YOUR_STATIC_IP:~/
```

On the server:

```bash
cd ~/nutricheck/nutricheck-api
gunzip -c ~/corpus-seed.sql.gz | \
  docker compose --env-file .env.prod -f docker/docker-compose.prod.yml \
  exec -T postgres psql -U nutricheck -d nutricheck
```

Verify:

```bash
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml \
  exec -T postgres psql -U nutricheck -d nutricheck \
  -c "SELECT source, count(*) FROM foods GROUP BY ROLLUP(source) ORDER BY 2 DESC;"
```

Expect **13,440** total: 7,793 `usda_sr`, 5,431 `usda_fndds`, 135
`usda_foundation`, 81 `curated`.

This must happen **after** migrations (the tables have to exist) and on an
**empty** corpus — the dump is data-only, so re-running it against populated
tables fails on primary keys.

<details>
<summary>Regenerating the seed from your dev database</summary>

```bash
docker exec nutricheck-postgres-1 pg_dump -U nutricheck -d nutricheck \
  --data-only --no-owner --no-privileges \
  -t foods -t food_nutrients -t food_portions \
  -t food_aliases -t food_embeddings -t food_barcodes \
  > corpus-seed.sql
gzip -9 corpus-seed.sql
```

`--no-owner --no-privileges` matters: without them the dump carries role grants
that will not exist on a fresh server.
</details>

## 8. Verify

```bash
curl -s https://api.yourdomain.com/health/live
curl -s https://api.yourdomain.com/health/ready
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml ps
```

All services should read `running`, except `migrate`, which correctly shows
`exited (0)`.

If TLS isn't working, it is almost always DNS. `docker compose ... logs caddy`
tells you plainly.

Check memory has settled where expected:

```bash
free -h
docker stats --no-stream
```

Roughly 2.7 GB used, ~1.3 GB free for page cache, swap near zero. If swap is
being used heavily at idle, something is wrong — look at Postgres first.

## 9. Running it

```bash
# from ~/nutricheck/nutricheck-api — define this once to save typing
alias dc='docker compose --env-file .env.prod -f docker/docker-compose.prod.yml'

dc logs -f api          # follow API logs
dc ps                   # what's running
dc restart api          # restart one service
dc down                 # stop everything (volumes survive)
```

**Deploying an update:**

```bash
git pull
dc up -d --build        # migrate re-runs automatically before api restarts
```

**Backups.** The corpus can always be rebuilt from the pinned USDA releases, but
user accounts and food logs cannot. Back those up:

```bash
dc exec -T postgres pg_dump -U nutricheck -d nutricheck --no-owner \
  | gzip > ~/backup-$(date +%F).sql.gz
```

Put that in a cron job and copy the result off the instance — a backup that
lives only on the machine it is backing up is not a backup. Lightsail's
automatic instance snapshots ($2–5/month) are the low-effort alternative and
cover the whole disk.

## 10. When 4 GB stops being enough

Two things move the needle, and neither is the corpus:

- **M2 embeddings.** Loading the ONNX model in-process adds roughly 400–700 MB
  to whichever process runs it, and it is CPU-bound. That is the point to move
  to the 8 GB plan, or give the worker its own instance. (Calling an embeddings
  API instead keeps you on 4 GB indefinitely — the tradeoff is per-query latency
  and a network dependency on the search path.)
- **A much larger corpus.** 13,440 foods is 26 MB. USDA Branded would be ~1.9M
  rows and several GB of vectors, and is excluded by design in
  `ingest-usda.ts`. Adding it means 16 GB+ and probably a managed database.

Ordinary user growth will not do it. The app is stateless; Postgres holds the
state, and 35 MB of it fits in `shared_buffers` with room to spare.

---

## Quick reference

| | |
|---|---|
| Instance | Lightsail 4 GB / 2 vCPU / 80 GB, Ubuntu 24.04 LTS, OS Only |
| Open ports | 22, 80, 443 — never 5432 or 6379 |
| Swap | 4 GB, added manually |
| Compose | `docker/docker-compose.prod.yml`, project `nutricheck-prod` |
| Secrets | `.env.prod` on the server, gitignored, from `.env.prod.example` |
| TLS | Caddy, automatic Let's Encrypt, needs DNS first |
| Corpus | restore `corpus-seed.sql.gz`, 13,440 foods |
| Migrations | one-shot `migrate` service, never on app boot |
