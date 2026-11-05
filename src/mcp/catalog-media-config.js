// Constructor configuration and one exact source-owned UPDATE eligibility rule.
// Neither function verifies a caller, resource ownership or human approval.
export function readMcpCatalogMediaUpdateConfig(env,{production,mcpEnabled,mcpV2,mcpMedia,shopMode,sellerQuickLogin}={}) {
  const flag=env.MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED===undefined?'0':env.MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED;
  if(!['0','1'].includes(flag))throw new Error('MCP_V2_CATALOG_MEDIA_UPDATE_ENABLED must be 0 or 1.');
  if(flag==='0')return Object.freeze({enabled:false});
  if(production!==false||!['development','test'].includes(env.NODE_ENV)||mcpEnabled!==true||mcpV2?.enabled!==true||
      mcpMedia?.enabled!==true||!/^[a-f0-9]{64}$/.test(mcpMedia.codecDigest||'')||shopMode!=='manual'||sellerQuickLogin!==false)
    throw new Error('Catalog media UPDATE requires explicit safe development media configuration; production activation is blocked.');
  return Object.freeze({enabled:true});
}

export function catalogMediaUpdateEnabled(config,{quickLogin,tenantGuard}={}) {
  return config?.mcpCatalogMediaUpdate?.enabled===true&&config.production===false&&config.mcpEnabled===true&&
    config.mcpV2?.enabled===true&&config.mcpMedia?.enabled===true&&/^[a-f0-9]{64}$/.test(config.mcpMedia.codecDigest||'')&&
    config.shopMode==='manual'&&quickLogin===false&&typeof tenantGuard?.withActiveTenant==='function';
}

export function catalogMediaUpdateAllowed(enabled,{toolName,mediaPolicyId,resourceType}={}) {
  return enabled===true&&['catalog.preview_update','catalog.commit_update'].includes(toolName)&&
    mediaPolicyId==='catalog-media-v1'&&resourceType==='product';
}
