variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "wiki-guesser"
}

variable "aws_region" {
  description = "Region to deploy into. Pick one close to your players — this is a reaction-time game."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Public hostname, e.g. wiki-guesser.com. Caddy provisions a Let's Encrypt certificate for it, so its DNS A record must point at the Elastic IP output by this stack BEFORE the first boot finishes."
  type        = string
}

variable "acme_email" {
  description = "Email for Let's Encrypt expiry notices."
  type        = string
}

variable "instance_type" {
  description = <<-EOT
    2 vCPU / 2 GiB on Graviton. Node is single-threaded and the SQLite reads are
    synchronous, so extra vCPUs buy nothing; memory is the only dimension that
    matters, because it decides how much of the pool stays page-cached. MUST be
    kept in step with ami_ssm_parameter, which is architecture-specific.

    2 GiB IS ENOUGH, and this was measured on the running 4 GiB box rather than
    estimated. Anon memory in use is ~357 MiB total: node 117, the CloudWatch
    agent 138 (yes, more than the app), caddy 56, the SSM agents ~48. The pool
    file is 919 MiB. On a 2 GiB machine that leaves ~1.6 GiB of page cache for a
    919 MiB pool - it fits whole, with ~670 MiB spare, and still fits if node
    triples under load. An earlier version of this note claimed the pool "would
    not fit" in 2 GiB; it was wrong by a factor of two.

    What the cgroup shows at boot (~962 MiB) is warmPartyIndex scanning the whole
    table - there is no index on `popularity` - not a standing requirement. The
    party tier that ranked and the dailies actually draw from is held in the JS
    heap, inside node's 117 MiB. Only chaos-tier casual rounds read randomly into
    the 919 MiB file, one article at a time, against gp3 at 3000 IOPS.

    CONSTRAINED BY THE ACCOUNT'S PLAN, which is not obvious and cost an outage to
    learn. On an AWS Free plan, RunInstances refuses ANY type that is not
    free-tier eligible, and the list is short and arbitrary-looking:

      c7i-flex.large (4 GiB), m7i-flex.large (8 GiB),
      t3.small / t4g.small (2 GiB), t3.micro / t4g.micro (1 GiB)

    Note what is absent: t4g.medium, the obvious 4 GiB Graviton choice. Switching
    to it on a free plan fails at RunInstances AFTER Terraform has destroyed the
    running instance, because aws_instance replacement is destroy-then-create.
    ALWAYS check the list before changing this:

      aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true

    `run-instances --dry-run` does NOT catch it - it validates IAM only and
    cheerfully reports that a t4g.medium "would have succeeded". The list above is
    the only reliable pre-flight.

    On a PAID plan the whole catalogue opens up and t4g.medium ($24.53/mo, 4 GiB)
    is the better answer - double the headroom for $12 more.
  EOT
  type        = string
  default     = "t4g.small"
}

variable "ami_ssm_parameter" {
  description = "SSM public parameter resolving to the latest Amazon Linux 2023 AMI. MUST match the instance architecture: -arm64 for t4g/m7g, -x86_64 for c7i-flex/m7i-flex/t3. A mismatch fails at RunInstances with an unhelpful error about the image. Nothing in user_data.sh.tftpl is architecture-bound - Caddy is selected by `uname -m`, Node comes from the distro repo, and better-sqlite3 ships a prebuilt linux-arm64 binary with a gcc fallback already installed - so this pair is the only thing that decides the architecture."
  type        = string
  default     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

variable "cpu_credits" {
  description = "Burstable CPU mode. 'unlimited' because exhausting credits throttles the instance to ~20% baseline, and for a real-time game that is not degradation but an outage — round timers slip and games desync. The surcharge only applies above baseline; watch CPUCreditBalance and move to a non-burstable type (m7g.medium) if it is sustained. NOTE: this setting is only emitted for T-family types (see the dynamic block in main.tf), so it was inert while instance_type was c7i-flex.large and became live again with the move to t4g.medium. There is no alarm on CPUCreditBalance — an idle-to-moderate game server sits far below the 20%/vCPU baseline, so surplus charges would mean real sustained load, which the event-loop-lag alarm would surface first anyway."
  type        = string
  default     = "unlimited"

  validation {
    condition     = contains(["standard", "unlimited"], var.cpu_credits)
    error_message = "cpu_credits must be \"standard\" or \"unlimited\"."
  }
}

variable "data_volume_size" {
  description = "GiB for the data volume holding both SQLite databases. The lean pool is ~908 MB; 20 GiB leaves room for the full 11 GB pool if you ever switch."
  type        = number
  default     = 20
}

variable "app_repo_url" {
  description = "Git URL cloned at boot. Must be reachable unauthenticated — for a private repo, bake the code into an AMI or ship a tarball to the artifacts bucket instead."
  type        = string
}

variable "app_repo_ref" {
  description = "Branch, tag, or commit to deploy. Pin to a tag for reproducible boots."
  type        = string
  default     = "main"
}

variable "mystery_pool_s3_key" {
  description = "Key of the mystery pool inside the artifacts bucket. Upload it once (see infra/README.md) — it is far too large for git. Matches the default output name of scripts/build-mysteries.js so the local file, the S3 key and the on-box filename are all the same name and there is no rename step to get wrong. The pool MUST have been built after the categories feature landed — see the preflight check in infra/README.md."
  type        = string
  default     = "mysteries.sqlite"
}

variable "allowed_http_cidrs" {
  description = "CIDRs allowed to reach 80/443. Leave open for Let's Encrypt HTTP-01 to work. If you later put Cloudflare in front (proxied), narrow this to Cloudflare's published ranges and switch Caddy to a Cloudflare Origin certificate."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  description = "CloudWatch retention for application logs. These contain IP addresses, so this number is a privacy commitment — keep it equal to the retention stated in public/privacy.html."
  type        = number
  default     = 30
}

variable "snapshot_retention_count" {
  description = "How many daily snapshots of the data volume to keep. This is your only backup of users, ratings, and match history."
  type        = number
  default     = 14
}

# ── Alerting ─────────────────────────────────────────────────────────────────

variable "alarm_email" {
  description = "Where alarm notifications are sent. Required on purpose — there is no sensible default for 'who finds out the game is down', and an alarm with no destination is worse than no alarm because it looks like monitoring. AWS emails a confirmation link on first apply; the subscription delivers nothing until you click it."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be a single valid email address."
  }
}

variable "error_alarm_threshold" {
  description = "Application errors in a 5-minute window before alerting. Steady state is zero; the threshold is set above 1 so a lone transient (one failed round, one SQLITE_BUSY) doesn't page you, while a genuine fault does."
  type        = number
  default     = 10
}

variable "loop_lag_alarm_ms" {
  description = "p99 event loop lag, in ms, that counts as degraded. Every mystery pick is a synchronous SQLite read, so sustained lag here means round timers are firing late and games are drifting. Measured p99 against the lean pool is ~33ms; 250 is comfortably clear of normal without waiting for players to notice."
  type        = number
  default     = 250
}

variable "chat_report_alarm_threshold" {
  description = "Player chat reports in a 5-minute window before alerting. Defaults to 1 — at launch scale you want to see every one, because a report is the only signal you get that someone is being harassed. Raise it if the game grows enough that individual reports stop being actionable."
  type        = number
  default     = 1
}

variable "disk_alarm_percent" {
  description = "Disk usage percentage that triggers an alarm, on both the data and root volumes. A full data volume means failed SQLite writes on live games."
  type        = number
  default     = 85
}

variable "google_client_id" {
  description = "Google OAuth client ID. Leave blank to disable Google sign-in."
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "discord_client_id" {
  description = "Discord OAuth client ID. Leave blank to disable Discord sign-in."
  type        = string
  default     = ""
  sensitive   = true
}

variable "discord_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

# ── Deploy pipeline ──────────────────────────────────────────────────────────

variable "github_repository" {
  description = "owner/repo permitted to assume the deploy role. This is a security boundary, not a label: it is matched against the OIDC token's `sub` claim, and anything looser than one exact repository lets other people's workflows deploy to your instance."
  type        = string
  default     = "kyle678-labs/wiki-guesser"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be exactly \"owner/repo\" — no URL, no wildcards, no trailing .git."
  }
}

variable "deploy_tag_pattern" {
  description = "Which tags may deploy, matched against the OIDC `sub` claim. \"v*\" means v1.0.0 and v2.1.3-rc1 deploy while a stray `scratch` tag does not. Widening this to \"*\" makes every tag a production deploy."
  type        = string
  default     = "v*"
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider. AWS allows only ONE per account, so if another stack already created it, apply fails with EntityAlreadyExists — put its ARN here rather than deleting it, since whatever created it is likely still using it. Leave empty to create one. Find it with: aws iam list-open-id-connect-providers"
  type        = string
  default     = ""
}

variable "caddy_version" {
  description = "Caddy release to install for TLS termination and reverse proxying. Pinned rather than tracking latest so a boot is reproducible — but this process terminates all TLS, so bump it deliberately rather than leaving it to age. Check that both linux_arm64 and linux_amd64 assets exist for the tag before changing it; user_data picks by architecture."
  type        = string
  default     = "2.11.4"
}

variable "node_major" {
  description = "Node.js major version. 22 is Active LTS; 18 is end-of-life and should not be used for a new deployment."
  type        = number
  default     = 22
}
