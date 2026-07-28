# ─────────────────────────────────────────────────────────────────────────────
# Alerting.
#
# An alarm that changes state and tells nobody is decoration, so everything here
# routes to one SNS topic and `alarm_email` is a required variable — you cannot
# stand this stack up without deciding who gets woken.
#
# The EC2 status check (below) is necessary but nowhere near sufficient: it stays
# green while the app crash-loops, wedges its event loop, fills its disk, or
# loses the mystery pool. The log-derived alarms are what actually watch the
# game. They work because the app already emits one JSON object per line —
# `metrics` every 60s, and `level: "error"` on anything that matters — so no
# custom instrumentation is needed, only filters over what is already shipped.
#
# External reachability is covered too, at the bottom of this file, by a Route53
# health check — the only probe here that sees what a player sees.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"

  # Deliberately unencrypted. SNS server-side encryption needs a customer-managed
  # KMS key (~$1/mo) because the AWS-managed alias/aws/sns cannot grant
  # cloudwatch.amazonaws.com permission to publish — a well-known dead end that
  # silently drops every notification. These messages carry an alarm name, a
  # metric and a state, and no player data.
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # Every alarm notifies on the way in AND on the way out — without ok_actions
  # you learn that something broke but never that it recovered, which trains you
  # to ignore the topic.
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  # The external alarm is pinned to us-east-1 and needs a topic there. When the
  # stack already lives in us-east-1 the primary topic is in the right region
  # and a second one would just be a second confirmation email to click.
  needs_external_topic = var.aws_region != "us-east-1"
  external_topic_arn   = local.needs_external_topic ? aws_sns_topic.alerts_external[0].arn : aws_sns_topic.alerts.arn
}

# ── Instance health ──────────────────────────────────────────────────────────
# The one failure mode that cannot be observed from inside the box.

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name}-status-check-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "EC2 status check failing — the game is almost certainly down."
  treat_missing_data  = "breaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions

  dimensions = { InstanceId = aws_instance.app.id }
}

# ── Application heartbeat ────────────────────────────────────────────────────
# metrics.js emits `{"event":"metrics",…}` every METRICS_INTERVAL_MS (60s). Its
# absence is the single highest-value signal in this file: it covers the process
# being dead, restart-looping faster than it can report, blocked long enough to
# stop emitting, and the instance being off the network — none of which move the
# EC2 status check.

resource "aws_cloudwatch_log_metric_filter" "heartbeat" {
  name           = "${local.name}-heartbeat"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"metrics\" }"

  metric_transformation {
    name      = "AppHeartbeat"
    namespace = var.project
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "heartbeat" {
  alarm_name          = "${local.name}-app-not-reporting"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  period              = 300
  threshold           = 1
  statistic           = "Sum"
  metric_name         = aws_cloudwatch_log_metric_filter.heartbeat.metric_transformation[0].name
  namespace           = var.project
  alarm_description   = "No metrics line for ~10 minutes — the app is down, wedged, or restart-looping."

  # A metric filter publishes nothing at all when the app is silent, so "no data"
  # IS the outage. This is the one alarm here that must treat missing as bad.
  treat_missing_data = "breaching"

  # Two 5-minute periods rather than one, so an ordinary deploy restart (seconds)
  # can never trip it.
  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions
}

# ── Application errors ───────────────────────────────────────────────────────
# log.js sends everything at warn and above to stderr with a `level` field.
# Catches round_failed, ranked_write_failed, healthz_db_failed, request_failed
# and the uncaught_exception / unhandled_rejection process guards.

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "${local.name}-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name      = "AppErrors"
    namespace = var.project
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.name}-error-rate"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  period              = 300
  threshold           = var.error_alarm_threshold
  statistic           = "Sum"
  metric_name         = aws_cloudwatch_log_metric_filter.errors.metric_transformation[0].name
  namespace           = var.project
  alarm_description   = "Sustained application errors — check the log group."

  # Steady state is zero errors, so silence here is genuinely good news. The
  # heartbeat alarm above is what covers "silent because dead".
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions
}

# ── Event loop lag ───────────────────────────────────────────────────────────
# The leading indicator, for the reason metrics.js spells out: every mystery pick
# is a synchronous SQLite read, so when the pool falls out of page cache the loop
# stalls, round timers fire late and games desync — all while CPU still looks
# unremarkable, because the process is blocked rather than busy. This alarm is
# the difference between finding out from a graph and finding out from a player.

resource "aws_cloudwatch_log_metric_filter" "loop_lag" {
  name           = "${local.name}-loop-lag"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"metrics\" }"

  metric_transformation {
    name      = "EventLoopLagP99"
    namespace = var.project
    value     = "$.loopLagP99Ms"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "loop_lag" {
  alarm_name          = "${local.name}-event-loop-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  period              = 300
  threshold           = var.loop_lag_alarm_ms
  statistic           = "Average"
  metric_name         = aws_cloudwatch_log_metric_filter.loop_lag.metric_transformation[0].name
  namespace           = var.project
  alarm_description   = "p99 event loop lag elevated for 15 minutes — rounds are drifting. Usually the mystery pool falling out of page cache."

  # Three periods: a single slow window is normal (a party-tier preload, a burst
  # of rooms starting at once). Fifteen sustained minutes is a real problem.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions
}

# ── Moderation ───────────────────────────────────────────────────────────────
# Chat is relayed in memory and never stored, so a report is the ONLY signal
# that something went wrong between two players. Without this it would land in a
# log nobody is reading at the time, which is the same as not having reporting
# at all — the point of a report is that someone is being harassed right now.
#
# The filter counts reports; it deliberately does not extract the message text
# into a metric. Metrics are retained for 15 months, far longer than the 30-day
# log retention that public/privacy.html commits to for reported messages.

resource "aws_cloudwatch_log_metric_filter" "chat_reports" {
  name           = "${local.name}-chat-reports"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"chat_report\" }"

  metric_transformation {
    name      = "ChatReports"
    namespace = var.project
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "chat_reports" {
  alarm_name          = "${local.name}-chat-reports"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  period              = 300
  threshold           = var.chat_report_alarm_threshold
  statistic           = "Sum"
  metric_name         = aws_cloudwatch_log_metric_filter.chat_reports.metric_transformation[0].name
  namespace           = var.project
  alarm_description   = "A player reported a chat message. Read it in the log group: filter on event=\"chat_report\"."

  # No reports is the normal state and the good one.
  treat_missing_data = "notBreaching"

  # Deliberately NO ok_actions. Everywhere else in this file the all-clear is
  # what stops you tuning out the topic, but here "no reports for five minutes"
  # is not news and would double the mail for every incident. The alarm falls
  # back to OK silently, which is also what re-arms it for the next report.
  alarm_actions = local.alarm_actions
}

# ── Liveness figures ─────────────────────────────────────────────────────────
# Not alarmed on — deliberately, because there is no threshold that means
# anything ("nobody is playing at 4am" is not an incident). These exist so the
# dashboard can answer "is anyone playing, and was it like this yesterday",
# which is the question you actually open a dashboard to ask, and so that a
# sudden cliff in connections has a graph to be visible on.

resource "aws_cloudwatch_log_metric_filter" "players" {
  name           = "${local.name}-players"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"metrics\" }"

  metric_transformation {
    name      = "PlayersOnline"
    namespace = var.project
    value     = "$.sockets"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "rooms" {
  name           = "${local.name}-rooms"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"metrics\" }"

  metric_transformation {
    name      = "RoomsActive"
    namespace = var.project
    value     = "$.rooms"
    unit      = "Count"
  }
}

# ── Disk ─────────────────────────────────────────────────────────────────────
# Both volumes matter and for different reasons: the data volume holds the
# SQLite databases (a full disk means failed writes on live games), and the root
# volume holds the app logs between logrotate runs.
#
# Alarms on the [InstanceId, path] rollup the CloudWatch agent is configured to
# publish. The raw disk metric also carries `device` and `fstype` dimensions,
# and the device is an unpredictable NVMe name — an alarm naming it would have
# to be written after the first boot and rewritten after any replacement.

resource "aws_cloudwatch_metric_alarm" "disk" {
  for_each = {
    data = "/var/lib/${var.project}"
    root = "/"
  }

  alarm_name          = "${local.name}-disk-${each.key}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  period              = 300
  threshold           = var.disk_alarm_percent
  statistic           = "Maximum"
  metric_name         = "disk_used_percent"
  namespace           = var.project
  alarm_description   = "${each.value} is over ${var.disk_alarm_percent}% full."
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions

  dimensions = {
    InstanceId = aws_instance.app.id
    path       = each.value
  }
}

# ── Backups ──────────────────────────────────────────────────────────────────
# The DLM policy in main.tf is the ONLY copy of users, ratings and match
# history. Until now nothing watched it, which is the same failure the alarms in
# this file exist to prevent: a backup that silently stopped is discovered on the
# day you need it, which is the worst possible day.
#
# Note the namespace: Data Lifecycle Manager publishes to AWS/EBS, NOT to an
# AWS/DLM namespace, dimensioned on DLMPolicyId. Getting that wrong yields an
# alarm stuck in INSUFFICIENT_DATA that looks like monitoring and is not.

resource "aws_cloudwatch_metric_alarm" "snapshot_failed" {
  alarm_name          = "${local.name}-snapshot-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 3600
  threshold           = 0
  statistic           = "Sum"
  metric_name         = "SnapshotsCreateFailed"
  namespace           = "AWS/EBS"
  alarm_description   = "A daily data volume snapshot FAILED. The player database is now protected only by older snapshots."

  # Zero failures emits nothing, so silence here is the good case. Absence of
  # snapshots entirely is a different question, and the alarm below asks it.
  treat_missing_data = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions

  dimensions = { DLMPolicyId = aws_dlm_lifecycle_policy.data.id }
}

resource "aws_cloudwatch_metric_alarm" "snapshot_missing" {
  alarm_name          = "${local.name}-snapshot-missing"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  statistic           = "Sum"
  metric_name         = "SnapshotsCreateCompleted"
  namespace           = "AWS/EBS"
  alarm_description   = "No data volume snapshot completed in two days — backups have stopped. The policy may be disabled, deleted, or its IAM role broken."

  # The failure this catches produces no metric at all (policy disabled, deleted,
  # role revoked), so missing data IS the outage.
  treat_missing_data = "breaching"

  # 86400 is CloudWatch's maximum period, and those buckets are aligned to UTC
  # midnight while the policy runs at 04:00 UTC. With a single evaluation period
  # the current, still-empty bucket would trip this every morning between
  # midnight and the snapshot. Requiring TWO consecutive empty days means a
  # healthy yesterday always suppresses it — at the cost of up to ~48h to notice
  # a genuine stoppage, which is proportionate for a backup whose RPO is 24h.
  period              = 86400
  evaluation_periods  = 2
  datapoints_to_alarm = 2

  alarm_actions = local.alarm_actions
  ok_actions    = local.ok_actions

  dimensions = { DLMPolicyId = aws_dlm_lifecycle_policy.data.id }
}

# ── External reachability ────────────────────────────────────────────────────
# The only black-box check in this file: Route53 health checkers hit the public
# hostname over HTTPS from ~15 locations worldwide, exactly as a player's browser
# would. Everything above runs inside AWS and therefore cannot see the failures
# that live between the instance and the internet — an expired or unrenewed
# certificate, a security-group edit, a DNS record pointed at the wrong IP, or an
# EIP detached by a botched apply. All of those keep the process happily logging
# its heartbeat while nobody can play.
#
# It probes /healthz rather than /, which means it also inherits that endpoint's
# opinion: the app returns 503 there when SQLite stops answering, so a database
# that has gone away registers as unreachable rather than as a 200 serving a
# broken game.

resource "aws_route53_health_check" "app" {
  type              = "HTTPS"
  fqdn              = var.domain_name
  port              = 443
  resource_path     = "/healthz"
  request_interval  = 30 # 10 is available but adds ~$1/mo and we don't need it
  failure_threshold = 3  # ~90s of consistent failure before it flips

  # Caddy serves a certificate per hostname, so the checkers must send SNI or
  # every probe fails the TLS handshake regardless of how healthy the app is.
  enable_sni = true

  tags = { Name = "${local.name}-external" }
}

# Health check metrics exist only in us-east-1 (see the provider note in
# versions.tf), and an alarm can only notify a topic in its own region — hence a
# second topic, created only when the stack itself lives somewhere else.
resource "aws_sns_topic" "alerts_external" {
  count    = local.needs_external_topic ? 1 : 0
  provider = aws.us_east_1

  name = "${local.name}-alerts-external"
}

resource "aws_sns_topic_subscription" "alerts_external_email" {
  count    = local.needs_external_topic ? 1 : 0
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.alerts_external[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "external" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-unreachable"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  period              = 60
  threshold           = 1
  statistic           = "Minimum"
  metric_name         = "HealthCheckStatus" # 1 = healthy, 0 = not
  namespace           = "AWS/Route53"
  alarm_description   = "${var.domain_name} is not reachable from the public internet over HTTPS. TLS, DNS, security group, or the app itself."

  # Route53 reports continuously, so a gap here is itself a problem.
  treat_missing_data = "breaching"

  alarm_actions = [local.external_topic_arn]
  ok_actions    = [local.external_topic_arn]

  dimensions = { HealthCheckId = aws_route53_health_check.app.id }
}

# ── Dashboard ────────────────────────────────────────────────────────────────
# One page to open when something feels wrong, or once a week when nothing does.
# Free — CloudWatch bills dashboards only past the third.
#
# Ordered the way you actually read it: is anyone playing, is the loop keeping
# up, is anything erroring, and is anything on fire. The `unreachable` alarm is
# absent from the status widget because it lives in us-east-1; the console links
# it from the Alarms page regardless.

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Players online / games in progress"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            [var.project, "PlayersOnline", { stat = "Maximum", label = "Players" }],
            [var.project, "RoomsActive", { stat = "Maximum", label = "Rooms" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Event loop lag p99 (ms) — the leading indicator"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            [var.project, "EventLoopLagP99", { stat = "Average", label = "p99 lag" }],
          ]
          annotations = {
            horizontal = [{ label = "alarm threshold", value = var.loop_lag_alarm_ms }]
          }
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Errors and heartbeat"
          region = var.aws_region
          view   = "timeSeries"
          period = 300
          metrics = [
            [var.project, "AppErrors", { stat = "Sum", label = "Errors" }],
            [var.project, "AppHeartbeat", { stat = "Sum", label = "Heartbeats (5 = healthy)" }],
          ]
        }
      },
      {
        type   = "alarm"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title = "Alarms"
          alarms = concat(
            [
              aws_cloudwatch_metric_alarm.status_check.arn,
              aws_cloudwatch_metric_alarm.heartbeat.arn,
              aws_cloudwatch_metric_alarm.errors.arn,
              aws_cloudwatch_metric_alarm.loop_lag.arn,
              aws_cloudwatch_metric_alarm.snapshot_failed.arn,
              aws_cloudwatch_metric_alarm.snapshot_missing.arn,
              aws_cloudwatch_metric_alarm.chat_reports.arn,
            ],
            [for a in aws_cloudwatch_metric_alarm.disk : a.arn]
          )
        }
      },
    ]
  })
}
