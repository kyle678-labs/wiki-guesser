# Infrastructure

Terraform for a single-instance production deployment on AWS.

## Why it looks like this

Wiki-Guesser is **one stateful process**. Rooms and matchmaking queues live in
memory, and SQLite is read synchronously from local disk. That rules out most of
the AWS defaults, on purpose:

| Not used | Why |
| --- | --- |
| ALB + Auto Scaling | Two instances can't share a room. Sticky sessions don't help — a room exists in exactly one process. |
| ECS / Fargate | The 908 MB mystery pool must sit on local disk and stay in page cache. EFS is both too slow and unsafe for SQLite's locking. |
| RDS | `better-sqlite3` opens a local file; it is not a network client. |

The result is roughly **$34/month** rather than the ~$75 an ALB-and-RDS shape
would cost. The trade is real and you should know it: **replacing the instance
ends every game in progress**, and there is no failover.

```
Internet → Elastic IP → EC2 t4g.medium
                          ├── Caddy :443  (TLS via Let's Encrypt, auto-renewed)
                          └── Node  :3000 (systemd, SIGTERM-drained)
                                └── EBS data volume  → daily DLM snapshots
                                      wiki-guesser.sqlite   (players, ratings)
                                      mysteries.sqlite      (read-only pool)
```

Secrets live in SSM Parameter Store, logs go to CloudWatch, and there is **no SSH**
— shell access is via Session Manager.

## First deploy

You need Terraform ≥ 1.6, AWS credentials, and a domain you control.

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init
terraform validate
terraform plan
```

Read the plan. When you're happy, apply in two phases. The Elastic IP has no
dependencies, so it can be allocated on its own first:

```bash
terraform apply -target=aws_eip.app
terraform output -raw public_ip
```

Set your DNS to that address now (step 1 below) and let it propagate. Then build
everything else:

```bash
terraform apply
```

Splitting it this way is not fussiness. Caddy requests a certificate near the end
of the instance bootstrap, and the ACME HTTP-01 challenge only succeeds if the
domain already resolves to the box — so a single apply leaves you racing the boot
to get a DNS record in. Allocating the address first turns that race into a step
you finish beforehand. A single `terraform apply` still works, and Caddy retries
with backoff if DNS lands late; you just wait through the backoff.

Then follow the `next_steps` output, in order — the sequence matters:

1. **Point DNS at the Elastic IP.** Caddy cannot get a certificate until
   `domain_name` resolves to the box. Use a DNS-only record, not a proxied one,
   so the ACME HTTP-01 challenge reaches the instance. **On Cloudflare the proxy
   is on by default and must be switched off** — see [Cloudflare](#cloudflare)
   below for why, and for what it would take to run proxied instead. A `www`
   CNAME is required too; the Caddyfile has a block for it.
2. **Upload the mystery pool.** It's ~908 MB and gitignored, so it is not in the
   repo the instance clones. Do this promptly — the instance starts booting the
   moment `apply` returns, and it fetches the pool once, early.

   **Check it first.** A pool built before the categories feature has no
   `categories` column, and on such a pool every category-filtered private round
   fails while everything else looks perfectly healthy — the picker just shows no
   counts. Uploading a stale pool is the easiest way to ship this broken, so
   verify before you spend ten minutes on the copy:
   ```bash
   npm run check:pool
   ```
   Then upload:
   ```bash
   aws s3 cp data/mysteries.sqlite s3://$(terraform output -raw artifacts_bucket)/mysteries.sqlite
   ```
3. **Watch the bootstrap.** It takes several minutes, mostly the pool download:
   ```bash
   aws ssm start-session --target $(terraform output -raw instance_id)
   sudo tail -f /var/log/user-data.log
   ```
4. **Verify:** `curl https://your-domain/healthz`
5. **Register the OAuth callbacks** printed in the `oauth_callback_urls` output.

### If the pool wasn't there when the instance booted

You'll see `WARNING: mystery pool unavailable` in `/var/log/user-data.log`. This
is not fatal — the bootstrap deliberately continues, so the site, TLS and the
systemd service all come up normally and only the rounds fail. Upload the pool,
then fetch it and restart:

```bash
sudo wiki-guesser-fetch-pool && sudo systemctl restart wiki-guesser
```

`wiki-guesser-fetch-pool` is idempotent — it no-ops if the pool is already on the
data volume — so it is always safe to run.

## Cloudflare

If `wiki-guesser.com` is on Cloudflare, the record must be **DNS-only (grey
cloud)**. That is the configuration this stack is built for, and it is not the
default — Cloudflare turns the proxy on for new A records automatically, so this
is an active step, not an absence of one.

Turning the orange cloud on breaks three things, in descending order of how long
they take to notice:

1. **Every player shares one rate-limit bucket.** Cloudflare presents its own
   edge IP to the origin. Express is configured `trust proxy: 1`, which trusts a
   single hop (Caddy) — so with Cloudflare in front it reads the *edge* IP as
   `req.ip`, not the player's. `RATE_LIMIT_API` (300 per 15 min) and
   `RATE_LIMIT_AUTH` (30 per 15 min) then apply to **all traffic combined**, and
   real players start getting 429s as soon as a few of them are online. The
   symptom — sign-in failing intermittently under load — looks nothing like its
   cause.
2. **Certificate issuance.** Caddy uses the ACME HTTP-01 challenge, which needs
   to reach the instance on port 80. Behind the proxy this depends on
   Cloudflare's SSL mode and its "Always Use HTTPS" setting, and the usual
   result is a boot that never gets a certificate.
3. **Request logs record Cloudflare, not players.** The privacy policy commits to
   logging IP addresses for abuse investigation; those logs stop being able to
   answer the question they exist for.

Cloudflare is still doing everything you actually need here — authoritative DNS,
registrar, DNSSEC — with the proxy off. The origin is a single small instance
with no autoscaling, so the CDN and DDoS features are not protecting anything
that could absorb the traffic anyway.

**If you later decide you do want the proxy**, it is three coordinated changes,
all of which have to land together:

- Set `TRUST_PROXY` hops to 2 in `/etc/wiki-guesser.env` (Cloudflare + Caddy).
  Note the app reads `TRUST_PROXY` as a boolean today and hardcodes `1` hop in
  `app.js` — that needs a code change, not just an env edit.
- Narrow `allowed_http_cidrs` to [Cloudflare's published ranges](https://www.cloudflare.com/ips/),
  or the origin IP remains directly reachable and anyone can bypass the proxy —
  and spoof `X-Forwarded-For` to defeat the rate limits entirely. Doing this also
  breaks the Route53 `unreachable` health check, whose ~15 checker locations are
  not in those ranges; add their ranges too, or drop the check.
- Switch Caddy to a Cloudflare Origin certificate (or SSL mode Full (strict)),
  and add Cloudflare as a recipient in `public/privacy.html` — proxied means they
  terminate TLS and see every request, which makes them a processor you are
  disclosing.

## Day-to-day

**Deploy a new version** — no Terraform involved:

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
sudo wiki-guesser-deploy          # or: sudo wiki-guesser-deploy v1.2.0
```

That pulls, reinstalls dependencies, refreshes `/etc/wiki-guesser.env` from SSM,
restarts under SIGTERM (so in-flight games drain rather than dying), and checks
`/healthz`.

**Change a secret or add an OAuth provider** — after `terraform apply` has
written the new values to SSM:

```bash
sudo wiki-guesser-refresh-env --restart
```

Parameters under `/wiki-guesser` are otherwise only read at instance boot, so
adding `GOOGLE_CLIENT_ID` and friends to SSM and redeploying used to have no
effect whatsoever: `wiki-guesser-deploy` pulls code, not configuration. The
provider simply stayed disabled, with nothing in any log to say why. This
rebuilds the env file from SSM, and refuses to replace a working one if the
fetch comes back without a `SESSION_SECRET` — the app will not boot without it,
so leaving the old file in place is always the safer failure.

`wiki-guesser-deploy` now calls it too, so an ordinary release picks up SSM
changes on its own; running it directly is for when you want the change applied
without shipping a new version.

> Both of these helpers are written to the instance by `user_data`, which runs
> **only at first boot** — `user_data_replace_on_change = false` means editing
> the template and applying will not update a running box. A box built before
> this change has no `wiki-guesser-refresh-env` on it; see the one-off command
> in the deploy notes below.

**Read logs** — the app emits one JSON object per line, so fields are directly
queryable in CloudWatch Logs Insights:

```
fields @timestamp, event, method, path, status, ms
| filter level = "error"
| sort @timestamp desc
```

**Restore the database** from a DLM snapshot: create a volume from the snapshot
in the same AZ, stop the instance, detach the current data volume, attach the
restored one as `/dev/sdf`, start.

Why that is safe, since it is worth knowing before you do it under pressure:

- The bootstrap only runs `mkfs` when `blkid` reports no filesystem, so a
  restored volume is **never** reformatted.
- `user_data` does not re-run on a stop/start — but it doesn't need to. EBS
  snapshots preserve the filesystem UUID, so the `/etc/fstab` line written on
  first boot still matches the restored volume and it mounts automatically.
- The service has `RequiresMountsFor=$DATA_DIR`, so it refuses to start against a
  missing mount rather than quietly creating a fresh, empty database on the root
  volume.

The mystery pool lives on this volume too, so a restore brings it back as well —
and since the pool never changes, it costs nothing after the first snapshot.

**Check the snapshots exist** — the two `snapshot-*` alarms do this continuously,
but this is how you confirm by hand:

```bash
aws ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$(terraform output -raw data_volume_id)" --query 'reverse(sort_by(Snapshots,&StartTime))[:5].[SnapshotId,StartTime,State]' --output table
```

You should see a snapshot per day, newest first, all `completed`.

### Is the snapshot actually restorable?

DLM snapshots are **crash-consistent, not quiesced**: they capture the volume
mid-write, with SQLite's WAL part-written. That is the same as pulling the power
cord, and it is the one property of a backup you cannot assume.

```bash
npm run drill:restore
```

The drill runs the app's real ranked-write path in separate processes, SIGKILLs
them mid-transaction, and then verifies the database exactly as a recovering app
would — SQLite's integrity check, foreign keys, and two invariants that hold only
if transactions are all-or-nothing (`games_played` must equal the matches a
player appears in; W+L+D must equal `games_played`). `integrity_check` alone
cannot see a torn transaction; those can.

It also measures two ways a hand-rolled backup goes wrong — copying the files one
at a time from a live database, and copying the `.sqlite` without its `-wal`.
**Both usually pass an integrity check while silently losing data**, because a
WAL checkpoint leaves a transactionally consistent *prefix* in the main file. A
backup that looks fine and isn't is the reason to snapshot the whole volume and
never to hand-roll this.

## Monitoring

Everything in `monitoring.tf` publishes to one SNS topic, subscribed by
`alarm_email`. That variable is **required** — an alarm with nowhere to go is
worse than no alarm, because it looks like monitoring.

> **Confirm the subscription.** AWS emails a link on the first apply and delivers
> nothing until you click it. `terraform output next_steps` includes the command
> to check; `PendingConfirmation` means you are not being alerted.

| Alarm | Fires when | Catches |
| --- | --- | --- |
| `status-check-failed` | EC2 status check fails 2 min | Hardware/hypervisor loss |
| `app-not-reporting` | No `metrics` log line for ~10 min | Process dead, restart-looping, event loop wedged, box off network |
| `error-rate` | ≥10 `level:"error"` lines in 5 min | Failing rounds, SQLite errors, uncaught exceptions |
| `event-loop-lag` | p99 > 250 ms for 15 min | The pool falling out of page cache — rounds drifting before players complain |
| `disk-data` / `disk-root` | >85% used for 10 min | A full data volume means failed SQLite writes on live games |
| `unreachable` | Route53 can't reach `https://<domain>/healthz` for 2 min | TLS expiry, DNS, security group, EIP detached — everything between the box and a player |
| `snapshot-failed` | A DLM snapshot returns a failure | A backup didn't happen; you're down to older snapshots |
| `snapshot-missing` | No snapshot completes for two days | The backup policy is disabled, deleted, or its IAM role broke |
| `chat-reports` | A player reports a chat message | Harassment or abuse, happening now — the only such signal you get |

The middle three are derived from the app's own JSON log lines by CloudWatch
metric filters, so they need no instrumentation beyond what `log.js` and
`metrics.js` already emit. `app-not-reporting` is the important one: it is the
only log-derived alarm that treats *missing* data as breaching, which is what
makes silence an alert rather than a blind spot.

Because of exactly that, **expect `app-not-reporting` and `unreachable` to fire on
the first apply** and clear once the bootstrap finishes, DNS resolves and Caddy
has its certificate. That is them working, not a misconfiguration.

`unreachable` is the only black-box check — the only one that sees what a player
sees. Note two consequences of how Route53 works:

- Its metrics exist **only in us-east-1**, and an alarm can only watch metrics in
  its own region, so that alarm and its SNS topic are pinned there. If
  `aws_region` isn't us-east-1 you get a second topic and **a second confirmation
  email**; both must be clicked.
- The checkers come from ~15 AWS locations worldwide. If you ever narrow
  `allowed_http_cidrs` (e.g. to Cloudflare's ranges), they lose access and the
  alarm goes permanently red. Add their published ranges, or delete the check.

The two snapshot alarms watch the DLM policy, which holds the **only** copy of
your players. Two things about them are worth knowing before they page you:

- DLM publishes to the **`AWS/EBS`** namespace (not `AWS/DLM`), dimensioned on
  `DLMPolicyId`. An alarm written against the wrong namespace sits in
  `INSUFFICIENT_DATA` forever and looks exactly like working monitoring.
- `snapshot-missing` needs **two consecutive empty days** before it fires.
  CloudWatch's longest period is 24h and those buckets align to UTC midnight,
  while the policy runs at 04:00 UTC — so a single-period version would trip
  every morning before the snapshot landed. The cost is up to ~48h to notice a
  real stoppage, which is proportionate for a backup with a 24h RPO.

`chat-reports` is the only alarm here that is about people rather than machines,
and the only one with **no `ok_actions`** — "no reports for five minutes" is not
news, and notifying on it would double the mail for every incident. It falls back
to OK silently, which is also what re-arms it for the next report. The filter
counts reports and deliberately does not lift the message text into a metric:
metrics are kept for 15 months, far longer than the 30-day retention the privacy
policy commits to for reported messages.

Memory is collected but deliberately not alarmed: on this box memory pressure
shows up as the pool being evicted from page cache, which `event-loop-lag`
already detects, and detects as the thing players actually feel. Likewise
`PlayersOnline` / `RoomsActive` are graphed but never alarmed — "nobody is
playing at 4am" is not an incident.

### The dashboard

`terraform output dashboard_url` — bookmark it. Four widgets: players and rooms,
event loop lag against its alarm threshold, errors and heartbeat, and current
alarm state. It is free (CloudWatch bills dashboards only past the third).

### When an alarm arrives

Every email names the alarm. Start there:

| Alarm | First thing to check |
| --- | --- |
| `unreachable` + `app-not-reporting` | The box or the app is down. `journalctl -u wiki-guesser -n 100` |
| `unreachable` alone | App is fine, the path to it isn't. TLS first: `curl -vI https://<domain>/healthz`, then `journalctl -u caddy -n 50` |
| `app-not-reporting` alone | Process is dead or wedged but externally still answering (rare). Check `systemctl status wiki-guesser` for a restart loop |
| `error-rate` | Logs Insights, filter `level="error"`, read the `event` field — it names the failure |
| `event-loop-lag` | Usually the pool falling out of page cache. `free -m`, and check whether something else is eating RAM |
| `disk-data` / `disk-root` | `df -h`. Root is usually logs between rotations; data is the SQLite files growing |
| `status-check-failed` | Hardware. Stop/start the instance (not reboot) to move it to new hardware |
| `chat-reports` | Read the report — it carries the message, who sent it and who reported it: `fields @timestamp, authorName, authorUserId, reporterName, message \| filter event = "chat_report" \| sort @timestamp desc`. `authorUserId` is null for guests, who cannot be banned; an account can be deleted from the database |
| `snapshot-failed` / `snapshot-missing` | Not urgent at 3am, but do not ignore it. Check the policy: `aws dlm get-lifecycle-policy --policy-id $(terraform output -raw dlm_policy_id)` — state should be `ENABLED`. Then confirm recent snapshots exist (command below) |

Shell in with:

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
```

The two commands worth knowing by heart:

```bash
sudo journalctl -u wiki-guesser -n 100 --no-pager
```

```bash
curl -s http://127.0.0.1:3000/healthz | jq
```

`/healthz` returns uptime, live room count, and the same loop-lag figures the
alarms watch — it is the fastest "is this box healthy right now" answer, and it
sidesteps TLS and DNS entirely because it talks to the app directly.

## Costs

Rough monthly, us-east-1, on-demand:

| Item | ~USD |
| --- | --- |
| t4g.medium (4 GiB) | 24.53 |
| Root EBS 20 GiB gp3 | 1.60 |
| Data EBS 20 GiB gp3 | 1.60 |
| Snapshots (14 daily, incremental) | ~1–2 |
| Elastic IP (attached) | 3.60 |
| CloudWatch logs, metrics, 10 alarms | ~4 |
| Route53 health check | 0.50 |
| SNS email alerts | ~0 (first 1,000/mo free) |
| Dashboard | 0 (first 3 free) |
| **Total** | **~$37** |

Monitoring is roughly $3 of that: custom metrics are $0.30 each (five from the
log metric filters, plus the CloudWatch agent's disk/memory rollups), alarms are
$0.10 each, and the health check is $0.50 at the 30-second interval. A new
account's free tier covers 10 metrics and 10 alarms for the first 12 months, so
expect closer to $34 initially.

A 1-year Compute Savings Plan takes the instance to roughly $15.40. Bandwidth is
negligible — article images are served from Wikimedia's CDN straight to the
player's browser and never transit this instance.

## Capacity

Expect **~1,000 concurrent players** to be comfortable, which is on the order of
25,000–30,000 daily actives at typical session lengths.

The governing constraint is not connections or bandwidth — it is that
`better-sqlite3` is synchronous, so every mystery pick blocks the whole event
loop for every room. Measured against the real lean pool, a party-tier pick cost
7.9 ms p50 / 32.6 ms p99 before the in-memory party index landed, and 2.1 ms p50
/ 6.1 ms p99 after. What remains is `rowToMystery` (JSON parse + clue building),
which is now the dominant per-round cost and applies to both tiers equally.

`t4g.medium` is chosen for its 4 GiB, not its vCPUs: Node is single-threaded and
the blocking read sits on that thread, so extra cores do almost nothing. The RAM
is what keeps the 908 MB pool page-cached, and a cold pool is what turns a 2 ms
pick back into a 30 ms one.

**Watch event-loop lag, not CPU.** `/healthz` reports `loopLagP50Ms` and
`loopLagP99Ms`, and the app logs a `metrics` line every 60 s. A blocked process
looks idle in CPU terms, so lag is the only metric that gives warning before
players feel it:

```
fields @timestamp, loopLagP99Ms, rooms, sockets, rssMb
| filter event = "metrics"
| sort @timestamp desc
```

Sustained p99 above ~50 ms means rounds are starting to drift. The
`event-loop-lag` alarm ships at 250 ms (`loop_lag_alarm_ms`) to stay clear of
false positives; tighten it once you have production readings. Note that a
Windows dev box idles around 16 ms purely from OS timer granularity, whereas
Linux idles near zero — so calibrate against the instance, not your laptop.

## Things this stack does not do yet

Named so they're decisions rather than oversights:

- **No auto-heal.** If the instance dies, the CloudWatch alarm fires but nothing
  replaces it. An ASG with `min=max=1` would, at the cost of a lifecycle hook to
  reattach the AZ-pinned data volume. Worth adding once the game has players who
  will notice.
- **No staging environment.** The module is parameterised, so a second workspace
  with a different `project` and `domain_name` gets you one.
- **Ads are off.** Turning them on has compliance prerequisites — see the note in
  `.env.example` and the root README.
