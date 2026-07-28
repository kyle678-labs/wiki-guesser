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
  description = "ARM (Graviton) instance. t4g.medium = 2 vCPU / 4 GiB. Node is single-threaded and the SQLite reads are synchronous, so extra vCPUs buy almost nothing — the 4 GiB is the point: it keeps the ~908 MB pool page-cached alongside the Node heap with room to spare, which is what actually governs latency. Changing to an x86 type also requires changing ami_ssm_parameter."
  type        = string
  default     = "t4g.medium"
}

variable "ami_ssm_parameter" {
  description = "SSM public parameter resolving to the latest Amazon Linux 2023 AMI. Must match the instance architecture (…-arm64 for t4g, …-x86_64 for t3)."
  type        = string
  default     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

variable "cpu_credits" {
  description = "Burstable CPU mode. 'unlimited' because exhausting credits throttles the instance to ~20% baseline, and for a real-time game that is not degradation but an outage — round timers slip and games desync. The surcharge only applies above baseline; watch CPUCreditBalance and move to a non-burstable type (m7g.medium) if it is sustained."
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
  description = "Key of the lean mystery pool inside the artifacts bucket. Upload it once (see infra/README.md) — it is far too large for git."
  type        = string
  default     = "mysteries-lean.sqlite"
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

variable "caddy_version" {
  description = "Caddy release to install for TLS termination and reverse proxying."
  type        = string
  default     = "2.8.4"
}

variable "node_major" {
  description = "Node.js major version. 22 is Active LTS; 18 is end-of-life and should not be used for a new deployment."
  type        = number
  default     = 22
}
