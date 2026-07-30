# ─────────────────────────────────────────────────────────────────────────────
# Wiki-Guesser — single-instance production stack.
#
# The app is one stateful process: rooms and matchmaking queues live in memory
# and SQLite is read synchronously from local disk. That rules out the usual
# AWS defaults, deliberately:
#
#   • No ALB / no autoscaling. Two instances cannot share a room, and stickiness
#     doesn't help — a room only exists in one process. min=max=1 or nothing.
#   • Not Fargate. The 908 MB mystery pool has to be on local disk and stay in
#     page cache; EFS would be both slow and unsafe for SQLite locking.
#   • Not RDS. better-sqlite3 is a local file, not a network client.
#
# What that buys you is a ~$20/month stack instead of a ~$60 one. What it costs
# you is that instance replacement ends every game in progress.
# ─────────────────────────────────────────────────────────────────────────────

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "ami" {
  name = var.ami_ssm_parameter
}

locals {
  name = var.project
  # EBS volumes are AZ-scoped, so the instance and its data volume are pinned to
  # one AZ for the life of the stack. That's the trade for keeping SQLite local.
  az         = data.aws_availability_zones.available.names[0]
  ssm_prefix = "/${var.project}"
}

# ── Network ──────────────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = local.az
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ── Security ─────────────────────────────────────────────────────────────────
# No SSH ingress. Shell access is via SSM Session Manager, which needs no open
# port, no key pair, and no bastion, and logs who connected:
#     aws ssm start-session --target <instance-id>

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "Wiki-Guesser web ingress"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = toset(var.allowed_http_cidrs)

  security_group_id = aws_security_group.app.id
  # ASCII only, and not as a style preference: EC2 validates this field against
  # a fixed character set (a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*) and rejects the
  # request outright otherwise. An em-dash here fails at apply time with
  # "Invalid rule description", which reads like a length problem and is not.
  description       = "HTTP - redirects to HTTPS, and serves the ACME HTTP-01 challenge"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.allowed_http_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "HTTPS - game traffic and the WebSocket upgrade"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound: package installs, ACME, OAuth providers, AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── Secrets ──────────────────────────────────────────────────────────────────
# The app refuses to boot in production without a strong SESSION_SECRET, so
# generate one rather than leaving a human to paste a weak string.

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "session_secret" {
  name        = "${local.ssm_prefix}/SESSION_SECRET"
  description = "Signs Wiki-Guesser session cookies"
  type        = "SecureString"
  value       = random_password.session_secret.result

  lifecycle {
    # Rotating this invalidates every signed-in session. Do it deliberately:
    # taint the random_password, apply, then restart the service.
    ignore_changes = [value]
  }
}

locals {
  oauth_params = {
    GOOGLE_CLIENT_ID      = var.google_client_id
    GOOGLE_CLIENT_SECRET  = var.google_client_secret
    DISCORD_CLIENT_ID     = var.discord_client_id
    DISCORD_CLIENT_SECRET = var.discord_client_secret
  }
  # Only create parameters for credentials actually supplied; the app treats a
  # missing provider as "disabled" and falls back to guests-only.
  #
  # for_each iterates the NAMES, not the map. Every value above comes from a
  # sensitive variable, which marks anything derived from it sensitive too —
  # including a map built by filtering on those values — and Terraform refuses
  # sensitive for_each arguments because each key becomes a resource address
  # that shows up in plan output and state. The names here are constants
  # (GOOGLE_CLIENT_ID and friends) and carry no secret; all nonsensitive()
  # discards is the inherited mark on which of them are present, which the
  # parameter names themselves already reveal. The secrets stay sensitive: they
  # are looked up from the map below, never used as a key.
  oauth_param_names = nonsensitive(toset([for k, v in local.oauth_params : k if v != ""]))
}

resource "aws_ssm_parameter" "oauth" {
  for_each = local.oauth_param_names

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "SecureString"
  value = local.oauth_params[each.key]
}

# ── Artifacts bucket ─────────────────────────────────────────────────────────
# Holds the pre-built mystery pool. S3 is the artifact store only — the instance
# copies the file to its local disk at boot and queries it from there.

resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${local.name}-artifacts-"
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Versioning keeps the previous pool so a bad rebuild can be rolled back — but
# each version is ~908 MB, so without this every upload silently adds ~$0.02/mo
# forever. Keep a month of rollback, then let them go.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket     = aws_s3_bucket.artifacts.id
  depends_on = [aws_s3_bucket_versioning.artifacts]

  rule {
    id     = "expire-old-pool-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ── IAM ──────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager access, plus the CloudWatch agent's own permissions.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid     = "ReadOwnParameters"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]

    # BOTH ARNs are required, and the first one is the non-obvious half.
    # GetParameter/GetParameters authorize against the individual parameter
    # (…:parameter/wiki-guesser/SESSION_SECRET), which the wildcard below
    # covers. GetParametersByPath authorizes against the PATH BEING QUERIED
    # (…:parameter/wiki-guesser) — a resource the wildcard does not match,
    # because there is no trailing segment after the prefix.
    #
    # Getting this wrong fails only at boot, and fails late: the bootstrap
    # writes an env file with no SESSION_SECRET, hits its own FATAL guard, and
    # exits under `set -e` before systemd, Caddy or the CloudWatch agent are
    # installed. The instance comes up healthy by every AWS measure and serves
    # nothing, with the logs explaining why still on local disk because the log
    # shipper was one of the things that never got installed.
    resources = [
      "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_prefix}",
      "arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptParameters"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  statement {
    sid       = "ListArtifacts"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name}-instance"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-instance"
  role = aws_iam_role.app.name
}

# ── Logs ─────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/app"
  retention_in_days = var.log_retention_days
}

# ── Compute ──────────────────────────────────────────────────────────────────

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ami.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # Burstable CPU credits are a T-series concept only. The c7i-flex / m7i-flex
  # families have their own baseline-and-burst model with no credit setting, and
  # sending this block for one of them is a RunInstances error rather than a
  # no-op. Emit it only when the instance type is actually a T.
  dynamic "credit_specification" {
    for_each = startswith(var.instance_type, "t") ? [1] : []

    content {
      cpu_credits = var.cpu_credits
    }
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  # Gzipped, because EC2 caps user data at 16 KB and this script had already
  # grown to 15.4 KB — 94% of the budget — which made every further edit a
  # gamble on a limit nobody was watching. cloud-init detects the gzip magic
  # bytes and decompresses before running, so nothing about the script changes;
  # it just arrives as ~7 KB instead of ~18 KB and there is room to work again.
  #
  # base64gzip is deterministic (Go's gzip writer leaves the header mtime at
  # zero), so this does not produce a perpetual diff on every plan.
  #
  # The one cost: `View user data` in the EC2 console now shows compressed
  # bytes rather than the script. Read it from git, or from
  # /var/log/user-data.log on the instance, which is where you would be looking
  # to debug a boot anyway.
  user_data_base64 = base64gzip(templatefile("${path.module}/user_data.sh.tftpl", {
    project             = var.project
    aws_region          = var.aws_region
    domain_name         = var.domain_name
    acme_email          = var.acme_email
    ssm_prefix          = local.ssm_prefix
    artifacts_bucket    = aws_s3_bucket.artifacts.bucket
    mystery_pool_s3_key = var.mystery_pool_s3_key
    app_repo_url        = var.app_repo_url
    app_repo_ref        = var.app_repo_ref
    log_group           = aws_cloudwatch_log_group.app.name
    caddy_version       = var.caddy_version
    node_major          = var.node_major
  }))

  # Editing user data does NOT rebuild the box — that would destroy every game in
  # progress on a cosmetic change. Re-run it yourself over SSM, or taint the
  # instance when you genuinely want a rebuild.
  user_data_replace_on_change = false

  # A new Amazon Linux AMI release shouldn't silently replace a running server.
  # Bump deliberately: terraform apply -replace=aws_instance.app
  lifecycle {
    ignore_changes = [ami]
  }

  tags = { Name = local.name }

  depends_on = [aws_ssm_parameter.session_secret]
}

# ── Data volume ──────────────────────────────────────────────────────────────
# Users, ratings, match history and sessions live here, separate from the root
# volume so rebuilding the instance doesn't take the database with it.

resource "aws_ebs_volume" "data" {
  availability_zone = local.az
  size              = var.data_volume_size
  type              = "gp3"
  encrypted         = true

  tags = {
    Name   = "${local.name}-data"
    Backup = "daily" # matched by the DLM policy below
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id
}

# Deliberately NOT tied to the instance via `instance = …`. Declaring the
# association separately leaves this resource with no dependencies at all, which
# means it can be created on its own, before anything else exists:
#
#     terraform apply -target=aws_eip.app
#     terraform output -raw public_ip     # set DNS, let it propagate
#     terraform apply                     # build the rest
#
# That ordering matters because Caddy asks Let's Encrypt for a certificate near
# the end of the instance bootstrap, and the HTTP-01 challenge only succeeds if
# the domain already resolves here. Allocating the address first turns a race
# against the boot into a step you complete beforehand. Caddy does retry with
# backoff, so getting this wrong is recoverable rather than fatal — but the
# retries are slow and Let's Encrypt caps failed validations at five per
# hostname per hour, so it is worth not needing them.
resource "aws_eip" "app" {
  domain = "vpc"

  tags = { Name = local.name }
}

# The instance keeps its launch-assigned public IP until this replaces it.
# Terraform creates the association immediately after the instance, which is
# minutes before user_data reaches the Caddy step, so the certificate request
# always goes out from the address DNS points at.
resource "aws_eip_association" "app" {
  allocation_id = aws_eip.app.id
  instance_id   = aws_instance.app.id
}

# ── Backups ──────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "${local.name} daily data volume snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = "daily" }

    schedule {
      name = "daily"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["04:00"] # UTC, chosen to be off-peak
      }

      retain_rule {
        count = var.snapshot_retention_count
      }

      copy_tags = true
    }
  }
}

# ── Alarms ───────────────────────────────────────────────────────────────────
# See monitoring.tf: the SNS topic every alarm notifies, the EC2 status check,
# and the log-derived alarms that watch the application itself.
