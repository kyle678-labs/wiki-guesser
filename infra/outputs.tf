output "public_ip" {
  description = "Elastic IP. Point your domain's A record here — Caddy cannot issue a certificate until DNS resolves to it."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "Shell in without SSH: aws ssm start-session --target <this>"
  value       = aws_instance.app.id
}

output "artifacts_bucket" {
  description = "Upload the mystery pool here before first boot."
  value       = aws_s3_bucket.artifacts.bucket
}

output "log_group" {
  description = "CloudWatch log group carrying the app's JSON logs."
  value       = aws_cloudwatch_log_group.app.name
}

output "oauth_callback_urls" {
  description = "Register these exactly in the Google and Discord developer consoles."
  value = {
    google  = "https://${var.domain_name}/auth/google/callback"
    discord = "https://${var.domain_name}/auth/discord/callback"
  }
}

output "alerts_topic_arn" {
  description = "SNS topic every alarm publishes to. Subscribe Slack/PagerDuty here if email isn't enough."
  value       = aws_sns_topic.alerts.arn
}

output "external_alerts_topic_arn" {
  description = "Topic for the external-reachability alarm. Pinned to us-east-1 because Route53 health check metrics only exist there; equals alerts_topic_arn when the stack is already in us-east-1."
  value       = local.external_topic_arn
}

output "dlm_policy_id" {
  description = "The snapshot policy guarding the player database. Used by the snapshot alarms and by the troubleshooting commands in README.md."
  value       = aws_dlm_lifecycle_policy.data.id
}

output "data_volume_id" {
  description = "The EBS volume holding users, ratings and match history. This is what the snapshots are of."
  value       = aws_ebs_volume.data.id
}

output "dashboard_url" {
  description = "The one page to open when something feels wrong. Bookmark it."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "next_steps" {
  description = "Ordered checklist after the first apply."
  value       = <<-EOT
    1. Point ${var.domain_name} A record at ${aws_eip.app.public_ip}.
       On Cloudflare this MUST be DNS-only (grey cloud), not proxied (orange):
       Let's Encrypt's HTTP-01 challenge has to reach the box, and behind the
       proxy the app would see Cloudflare's IP as every player's IP and rate-limit
       them all into one shared bucket. See "Cloudflare" in infra/README.md.
    2. Check, then upload, the mystery pool:
         npm run check:pool
         aws s3 cp data/${var.mystery_pool_s3_key} s3://${aws_s3_bucket.artifacts.bucket}/${var.mystery_pool_s3_key}
    3. Watch the bootstrap:
         aws ssm start-session --target ${aws_instance.app.id}
         sudo tail -f /var/log/user-data.log
    4. Verify: curl https://${var.domain_name}/healthz
    5. Register the OAuth callback URLs above with Google and Discord.
    6. CONFIRM THE ALARM EMAIL${local.needs_external_topic ? "S (there are TWO)" : ""}. AWS has sent a subscription
       confirmation to ${var.alarm_email}. Until you click the link, alarms fire
       into a topic with no confirmed subscriber and you are told nothing.
       Check spam. Verify with:
         aws sns list-subscriptions-by-topic --topic-arn ${aws_sns_topic.alerts.arn} \
           --region ${var.aws_region} --query 'Subscriptions[].SubscriptionArn'
       "PendingConfirmation" means it is NOT active yet.
    %{~if local.needs_external_topic}
       A SECOND confirmation covers the external-reachability alarm, which is
       pinned to us-east-1. Both emails must be confirmed:
         aws sns list-subscriptions-by-topic --topic-arn ${local.external_topic_arn} \
           --region us-east-1 --query 'Subscriptions[].SubscriptionArn'
    %{~endif}
    7. Bookmark the dashboard (dashboard_url output above).

    If step 2 landed after the instance had already booted, the log shows
    "WARNING: mystery pool unavailable". The site is up; only the rounds fail.
    Upload the pool, then:
         sudo ${var.project}-fetch-pool && sudo systemctl restart ${var.project}
  EOT
}
