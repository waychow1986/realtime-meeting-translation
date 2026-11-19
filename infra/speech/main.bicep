// Dependency "speech": Azure AI Foundry (AIServices) resource used for real-time
// speech-to-text with continuous language identification.
// Only adds resources to the platform-injected resource group. No subscription scope,
// role assignments, policies or tag names/values are written here (platform injects tags).
targetScope = 'resourceGroup'

@description('Region of the resource; must support Speech continuous language identification.')
param location string = resourceGroup().location

@description('Resource name prefix.')
@minLength(3)
@maxLength(20)
param namePrefix string = 'rtmt-speech'

var accountName = toLower('${namePrefix}-${uniqueString(resourceGroup().id, 'speech')}')

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
    // Custom subdomain is required for Microsoft Entra (platform-identity) token exchange.
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    // Local (key) auth stays enabled so that the "credential" auth mode remains selectable.
    disableLocalAuth: false
  }
}

output resourceId string = account.id
output region string = account.location
output endpointHost string = '${accountName}.cognitiveservices.azure.com:443'
output sttHost string = '${account.location}.stt.speech.microsoft.com:443'
output ttsHost string = '${account.location}.tts.speech.microsoft.com:443'
#disable-next-line outputs-should-not-contain-secrets
output key string = account.listKeys().key1
