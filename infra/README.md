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

## Costs

Rough monthly, us-east-1, on-demand:

| Item | ~USD |
| --- | --- |
| t4g.medium (4 GiB) | 24.53 |
| Root EBS 20 GiB gp3 | 1.60 |
| Data EBS 20 GiB gp3 | 1.60 |
| Snapshots (14 daily, incremental) | ~1–2 |
| Elastic IP (attached) | 3.60 |
| CloudWatch logs + metrics | ~1 |
| **Total** | **~$34** |

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

Sustained p99 above ~50 ms means rounds are starting to drift. Set the alarm
threshold from production readings — a Windows dev box idles around 16 ms purely
from OS timer granularity, whereas Linux idles near zero.

## Things this stack does not do yet

Named so they're decisions rather than oversights:

- **No auto-heal.** If the instance dies, the CloudWatch alarm fires but nothing
  replaces it. An ASG with `min=max=1` would, at the cost of a lifecycle hook to
  reattach the AZ-pinned data volume. Worth adding once the game has players who
  will notice.
- **The alarm has no action.** Attach an SNS topic and subscribe your email —
  two resources, and it's the difference between monitoring and being told.
- **No staging environment.** The module is parameterised, so a second workspace
  with a different `project` and `domain_name` gets you one.
- **Ads are off.** Turning them on has compliance prerequisites — see the note in
  `.env.example` and the root README.
