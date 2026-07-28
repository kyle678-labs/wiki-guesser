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
                                      mysteries-lean.sqlite (read-only pool)
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

Read the plan. When you're happy:

```bash
terraform apply
```

Then follow the `next_steps` output, in order — the sequence matters:

1. **Point DNS at the Elastic IP.** Caddy cannot get a certificate until
   `domain_name` resolves to the box. Use a DNS-only record, not a proxied one,
   so the ACME HTTP-01 challenge reaches the instance.
2. **Upload the mystery pool.** It's ~908 MB and gitignored, so it is not in the
   repo the instance clones. Do this promptly — the instance starts booting the
   moment `apply` returns, and it fetches the pool once, early:
   ```bash
   aws s3 cp data/mysteries-lean.sqlite s3://$(terraform output -raw artifacts_bucket)/mysteries-lean.sqlite
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

## Day-to-day

**Deploy a new version** — no Terraform involved:

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
sudo wiki-guesser-deploy          # or: sudo wiki-guesser-deploy v1.2.0
```

That pulls, reinstalls dependencies, restarts under SIGTERM (so in-flight games
drain rather than dying), and checks `/healthz`.

**Read logs** — the app emits one JSON object per line, so fields are directly
queryable in CloudWatch Logs Insights:

```
fields @timestamp, event, method, path, status, ms
| filter level = "error"
| sort @timestamp desc
```

**Restore the database** from a DLM snapshot: create a volume from the snapshot
in the same AZ, stop the instance, detach the current data volume, attach the
restored one as `/dev/sdf`, start. The bootstrap detects an existing filesystem
and mounts it without reformatting.

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

The last three are derived from the app's own JSON log lines by CloudWatch metric
filters, so they need no instrumentation beyond what `log.js` and `metrics.js`
already emit. `app-not-reporting` is the important one: it is the only alarm that
treats *missing* data as breaching, which is what makes silence an alert rather
than a blind spot.

Because of exactly that, **expect `app-not-reporting` to fire on the first apply**
and clear once the bootstrap finishes and the app logs its first metrics line.
That is the alarm working, not a misconfiguration.

**What is not covered:** every check above runs inside AWS, so a broken TLS
certificate, a security-group mistake, or a DNS problem all look perfectly
healthy. Let's Encrypt emails `acme_email` 20 days before expiry, which covers
the likeliest case. For true black-box monitoring, add a Route53 health check
against `https://<domain>/healthz` — note that its CloudWatch metrics only exist
in **us-east-1**, so unless you deploy there it needs a second provider alias and
a topic in that region.

Memory is collected but deliberately not alarmed: on this box memory pressure
shows up as the pool being evicted from page cache, which `event-loop-lag`
already detects, and detects as the thing players actually feel.

## Costs

Rough monthly, us-east-1, on-demand:

| Item | ~USD |
| --- | --- |
| t4g.medium (4 GiB) | 24.53 |
| Root EBS 20 GiB gp3 | 1.60 |
| Data EBS 20 GiB gp3 | 1.60 |
| Snapshots (14 daily, incremental) | ~1–2 |
| Elastic IP (attached) | 3.60 |
| CloudWatch logs, metrics, 6 alarms | ~3 |
| SNS email alerts | ~0 (first 1,000/mo free) |
| **Total** | **~$36** |

Monitoring is roughly $2 of that: custom metrics are $0.30 each (three from the
log metric filters, plus the CloudWatch agent's disk/memory rollups) and alarms
are $0.10 each. A new account's free tier covers 10 metrics and 10 alarms for the
first 12 months, so expect closer to $34 initially.

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
- **No external (black-box) check.** Everything is monitored from inside AWS, so
  a TLS or DNS failure reads as healthy. See the note under Monitoring.
- **No staging environment.** The module is parameterised, so a second workspace
  with a different `project` and `domain_name` gets you one.
- **Ads are off.** Turning them on has compliance prerequisites — see the note in
  `.env.example` and the root README.
