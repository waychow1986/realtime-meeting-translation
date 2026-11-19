// Dependency "chat-model": Azure AI Foundry (AIServices) resource with a chat model
// deployment used for translation with reasoning disabled (reasoning_effort "none").
// gpt-sol-6.1 is the customer's preferred model (preference, not a hard constraint).
// Only adds resources to the platform-injected resource group. No subscription scope,
// role assignments, policies or tag names/values are written here (platform injects tags).
targetScope = 'resourceGroup'

@description('Region of the resource; must offer the selected model.')
param location string = resourceGroup().location

@description('Resource name prefix.')
@minLength(3)
@maxLength(20)
param namePrefix string = 'rtmt-llm'

@description('Model name (preferred: gpt-sol-6.1).')
param modelName string = 'gpt-sol-6.1'

@description('Model version; empty uses the service default version.')
param modelVersion string = ''

@description('Deployment name used by the application as the "model" field.')
param deploymentName string = 'gpt-sol-6.1'

@description('Deployment SKU.')
param deploymentSku string = 'GlobalStandard'

@description('Deployment capacity (thousands of tokens per minute).')
@minValue(1)
param capacity int = 50

var accountName = toLower('${namePrefix}-${uniqueString(resourceGroup().id, 'chat-model')}')

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    // Key auth stays enabled so that the "credential" auth mode remains selectable.
    disableLocalAuth: false
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: deploymentSku
    capacity: capacity
  }
  properties: {
    model: empty(modelVersion) ? {
      format: 'OpenAI'
      name: modelName
    } : {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

output resourceId string = account.id
output endpointHost string = '${accountName}.openai.azure.com:443'
output deploymentName string = deployment.name
#disable-next-line outputs-should-not-contain-secrets
output key string = account.listKeys().key1
