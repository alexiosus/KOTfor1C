import { VANESSA_MCP_COMPONENT } from './vanessaControlProvisioning';

export interface McpPermissionsReport {
    name: string;
    version: string;
    safeMode: false;
    unsafeActionProtection: boolean;
    active: true;
}

/** The helper reports persisted extension settings; a process exit alone is not readiness. */
export function parseMcpPermissionsReport(text: string): McpPermissionsReport {
    let report;
    try { report = JSON.parse(text.replace(/^\uFEFF/u, '')); } catch { /* sanitized below */ }
    if (!report || report.error || report.name !== VANESSA_MCP_COMPONENT.name
        || report.version !== VANESSA_MCP_COMPONENT.version || report.safeMode !== false
        || report.active !== true || typeof report.unsafeActionProtection !== 'boolean') {
        throw new Error('Could not verify Vanessa MCP extension settings in the service infobase.');
    }
    return report;
}
