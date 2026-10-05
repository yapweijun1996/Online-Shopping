// Describes preparation only. No provider is connected or enabled by this catalog.
export function integrationCatalog() {
  return { status: 'NOT_CONFIGURED', dispatchEnabled: false, providers: [
    { id: 'NINJA_VAN', name: 'Ninja Van', category: 'shipping', contract: 'PUBLIC_DOCUMENTATION',
      plannedCapabilities: ['createShipment', 'cancelShipment', 'label', 'tracking', 'signedWebhook'] },
    { id: 'SPX', name: 'SPX Express', category: 'shipping', contract: 'PRIVATE_CONTRACT_REQUIRED',
      plannedCapabilities: [] },
    { id: 'WHATSAPP_CLOUD', name: 'WhatsApp Business Platform', category: 'messaging', contract: 'PUBLIC_DOCUMENTATION',
      plannedCapabilities: ['consentedMessage', 'approvedTemplate', 'signedWebhook'] },
    { id: 'WHATSAPP_QR', name: 'WhatsApp QR · unofficial', category: 'messaging', contract: 'RISK_REVIEW_REQUIRED',
      plannedCapabilities: [] },
  ].map(provider => ({ ...provider, status: 'NOT_CONFIGURED', enabledCapabilities: [],
    readiness: { offlineFoundation: true, sandboxVerified: false, providerApproved: false, liveAccepted: false } })) };
}
