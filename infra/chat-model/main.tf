# Dependency "chat-model": Azure AI Foundry (AIServices) resource with a chat model
# deployment used for translation with reasoning disabled (reasoning_effort "none").
# gpt-sol-6.1 is the customer's preferred model (preference, not a hard constraint, A-05).
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
  }
}

provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}

locals {
  account_name    = lower("rtmt-llm-${var.aidh_suffix}")
  model_name      = "gpt-sol-6.1"
  deployment_name = "gpt-sol-6.1"
  deployment_sku  = "GlobalStandard"
  # Thousands of tokens per minute. A page issues about 1-3 short translation calls per second
  # (about 150-300 tokens each), roughly 30-50K TPM for 1-2 concurrent pages in the test env.
  capacity = 50
}

resource "azurerm_cognitive_account" "chat" {
  name                          = local.account_name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  kind                          = "AIServices"
  sku_name                      = "S0"
  custom_subdomain_name         = local.account_name
  public_network_access_enabled = true
  # Key auth stays enabled so that the "credential" auth mode remains selectable.
  local_auth_enabled = true

  tags = var.aidh_tags
}

resource "azurerm_cognitive_deployment" "chat" {
  name                 = local.deployment_name
  cognitive_account_id = azurerm_cognitive_account.chat.id

  model {
    format = "OpenAI"
    name   = local.model_name
    # version omitted: the service default version of the model is used.
  }

  sku {
    name     = local.deployment_sku
    capacity = local.capacity
  }
}

output "resourceId" {
  value = azurerm_cognitive_account.chat.id
}

output "endpointHost" {
  value = "${local.account_name}.openai.azure.com:443"
}

output "deploymentName" {
  value = azurerm_cognitive_deployment.chat.name
}

output "key" {
  value     = azurerm_cognitive_account.chat.primary_access_key
  sensitive = true
}
