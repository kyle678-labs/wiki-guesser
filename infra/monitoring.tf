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
# NOT covered here, deliberately: external reachability. Every check below runs
# inside AWS, so a broken TLS certificate or a security-group mistake looks
# healthy. Let's Encrypt emails `acme_email` 20 days before expiry, which is the
# backstop for the likeliest case. See the note in README.md for adding a
# Route53 health check if you want true black-box monitoring.
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
