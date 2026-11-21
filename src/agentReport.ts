import { type AgentRecord } from './agentStore';

const inline = (value: unknown) => String(value ?? '').replace(/[\r\n|]/gu, ' ');
export function renderAgentReport(record: AgentRecord, linked: readonly AgentRecord[] = []): string {
    const lines = [`# KOT: ${inline(record.kind)}`, '', `Operation: ${record.id}`, `Status: ${record.status}`,
        `Created: ${record.createdAt}`, `Updated: ${record.updatedAt}`, '', '## Recorded execution facts', ''];
    const finishes = [record, ...linked].flatMap(operation => operation.events.filter(event => event.kind === 'test_finished').map(event => ({ ...event, runId: operation.id })));
    if (finishes.length) {
        lines.push('| Test | Run | Result |', '|---|---|---|');
        for (const event of finishes) { const data = event.data as { test: string; result: { status: string } }; lines.push(`| ${inline(data.test)} | ${event.runId} | ${inline(data.result.status)} |`); }
    } else { lines.push('No confirmed test executions are attached to this operation.'); }
    lines.push('', '## Findings and observations', '');
    const observations = record.events.filter(event => ['finding', 'check', 'hypothesis', 'verification', 'test_started', 'user_decision', 'stop_requested', 'host_restarted'].includes(event.kind));
    for (const event of observations) { lines.push(`### ${event.time}: ${event.kind}`, '', '```json', JSON.stringify(event.data, null, 2), '```', ''); }
    if (!observations.length) { lines.push('No findings recorded.', ''); }
    for (const repair of [record, ...linked].filter(item => item.kind === 'repair')) {
        lines.push(`## Repair ${repair.id}`, '', `Status: ${repair.status}`, '', String(repair.request.reason ?? ''), '', '```json',
            JSON.stringify({ evidence: repair.request.evidence, risks: repair.request.risks, result: repair.result }, null, 2), '```', '');
    }
    lines.push('## Artifacts', '');
    for (const operation of [record, ...linked]) { for (const artifact of operation.artifacts) { lines.push(`- ${inline(artifact.name)}: operation ${operation.id}, artifact ${artifact.id}; SHA-256 ${artifact.sha256}; ${artifact.size} bytes`); } }
    lines.push('', '## Result', '', '```json', JSON.stringify(record.result ?? { pending: true }, null, 2), '```', '',
        'Agent findings are assessments. Execution statuses and artifacts are recorded separately. A passed probe does not establish a passed full feature.', '');
    return lines.join('\n');
}
