# ─────────────────────────────────────────────────────────────────────────────
# Deploy pipeline — GitHub Actions → SSM → the redeploy helper already on the box.
#
# The instance pulls; nothing pushes to it. There is no SSH key, no open port and
# no runner inside the VPC. GitHub authenticates with a short-lived OIDC token
# exchanged for a role, so there are no long-lived AWS keys in repo secrets to
# leak or rotate.
#
# Two deliberate narrowings, because anyone who can push a tag to the repo can
# assume this role:
#
#   • The role may invoke ONE SSM document, defined below, whose only action is
#     to run /usr/local/bin/wiki-guesser-deploy. Granting AWS-RunShellScript
#     instead — the obvious shortcut — would be handing out arbitrary root shell
#     on the instance to anyone who can create a tag.
#   • The trust policy is scoped to tag refs on one repository. A `sub` condition
#     any looser than this (a wildcard repo, or omitting the condition) lets ANY
#     GitHub repository in the world assume the role. This is the single most
#     common way OIDC setups are misconfigured.
# ─────────────────────────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}

# ── Identity provider ────────────────────────────────────────────────────────
# AWS permits exactly ONE provider per URL per account. If another stack in this
# account already registered GitHub, creating a second is an EntityAlreadyExists
# error — pass the existing ARN in github_oidc_provider_arn instead of deleting
# anything, since whatever created it is probably still using it.

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == "" ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]

  # These thumbprints are no longer what actually secures the connection: since
  # 2023 AWS validates token.actions.githubusercontent.com against its own trust
  # store for this provider. They are kept because the API still expects the
  # field, and are NOT something to monitor for rotation — a stale value here
  # does not break authentication.
}

locals {
  github_oidc_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

# ── Deploy document ──────────────────────────────────────────────────────────
# The whole privilege surface of the pipeline. `allowedPattern` is enforced by
# SSM itself, server-side, before anything reaches the shell — so a ref crafted
# to inject (`v1; rm -rf /`) is rejected by the API rather than quoted-and-hoped.

resource "aws_ssm_document" "deploy" {
  name            = "${local.name}-deploy"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Deploy a git ref of Wiki-Guesser and restart the service."
    parameters = {
      gitRef = {
        type           = "String"
        description    = "Git ref (tag, branch or commit) to deploy."
        allowedPattern = "^[A-Za-z0-9._/-]{1,100}$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deploy"
      inputs = {
        # SSM runs this as root, which the helper needs (systemctl, chown).
        runCommand = ["/usr/local/bin/${var.project}-deploy '{{ gitRef }}'"]
      }
    }]
  })
}

# ── Role ─────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Tag pushes only. A workflow run on a branch presents
    # `repo:owner/name:ref:refs/heads/…` and fails this test, so a push to main
    # cannot deploy even if someone adds a branch trigger to the workflow.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/tags/${var.deploy_tag_pattern}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${local.name}-deploy"
  description        = "Assumed by GitHub Actions on tag pushes to redeploy the app."
  assume_role_policy = data.aws_iam_policy_document.github_assume.json

  # Long enough for npm ci and a restart, short enough that a leaked token is
  # not a lasting problem. The workflow needs nothing beyond one deploy.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid     = "RunTheDeployDocument"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.app.id}",
      aws_ssm_document.deploy.arn,
    ]
  }

  # Both halves matter: the document ARN alone would allow running the deploy
  # against any instance in the account, and the instance ARN alone would allow
  # running any document against this one.

  statement {
    sid     = "ReadTheResult"
    actions = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    # Command IDs do not exist until SendCommand returns, so there is nothing to
    # scope to ahead of time. Read-only, and only over invocations this account
    # made.
    resources = ["*"]
  }

  statement {
    sid     = "FindTheInstance"
    actions = ["ec2:DescribeInstances"]
    # The EC2 Describe* actions do not support resource-level permissions at all.
    # The workflow looks the instance up by tag rather than carrying a hardcoded
    # id that would silently go stale the first time the instance is replaced.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${local.name}-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
