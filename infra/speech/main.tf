# Dependency "speech": Azure AI Foundry (AIServices) resource used for real-time
# speech-to-text with continuous language identification (universal/v2 endpoint).
#
# Platform rules (execution/cloud.md, form "terraform"):
# - Only adds resources to the platform-injected resource group (var.resource_group_name).
# - var.resource_group_name, var.location, var.aidh_tags and var.aidh_suffix are declared and
#   valued by the platform; they are only referenced here, never declared.
# - Only create actions; platform tags come from var.aidh_tags; the provider block carries no
#   sign-in or scope settings (the platform supplies them).
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.0.0, < 5.0.0"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

provider "azurerm" {
  features {}
  # The platform's creation identity is scoped to the resource group; do not try to
  # register resource providers outside the resource group.
  resource_provider_registrations = "none"
}

# Extra random part of the account name. var.aidh_suffix is fixed per request, so a retried
# apply would otherwise collide with an account left by an earlier attempt or with a
# soft-deleted account of the same name (Cognitive Services keeps deleted names reserved).
resource "random_string" "name" {
  length  = 4
  lower   = true
  upper   = false
  numeric = true
  special = false
}

locals {
  # Also used as the custom subdomain, which must be globally unique.
  account_name = lower("rtmt-speech-${var.aidh_suffix}-${random_string.name.result}")
}

resource "azurerm_cognitive_account" "speech" {
  name                = local.account_name
  resource_group_name = var.resource_group_name
  location            = var.location
  kind                = "AIServices"
  sku_name            = "S0"

  # Custom subdomain is required for Microsoft Entra (platform-identity) token exchange
  # at https://{subdomain}.cognitiveservices.azure.com/sts/v1.0/issueToken.
  custom_subdomain_name         = local.account_name
  public_network_access_enabled = true
  # Key auth stays enabled so that the "credential" auth mode remains selectable.
  local_auth_enabled = true

  tags = var.aidh_tags
}

locals {
  # Normalised region name, e.g. "eastus".
  region = lower(replace(azurerm_cognitive_account.speech.location, " ", ""))
}

output "resourceId" {
  value = azurerm_cognitive_account.speech.id
}

output "region" {
  value = local.region
}

output "endpointHost" {
  value = "${local.account_name}.cognitiveservices.azure.com:443"
}

output "sttHost" {
  value = "${local.region}.stt.speech.microsoft.com:443"
}

output "ttsHost" {
  value = "${local.region}.tts.speech.microsoft.com:443"
}

output "key" {
  value     = azurerm_cognitive_account.speech.primary_access_key
  sensitive = true
}
