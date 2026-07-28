terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state is strongly recommended once this is real — it holds the
  # generated session secret. Create the bucket + lock table first, then
  # uncomment and `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket       = "wiki-guesser-tfstate"
  #   key          = "prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

# Route53 publishes health check metrics ONLY to us-east-1, and a CloudWatch
# alarm can only watch metrics in its own region. So the external-reachability
# alarm in monitoring.tf — and the SNS topic it notifies — have to live here,
# regardless of where the instance runs. Declared unconditionally; if aws_region
# already is us-east-1 this simply duplicates the default provider and the extra
# topic is skipped.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}
