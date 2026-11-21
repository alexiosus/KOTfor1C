import { runAgentMcpBridge } from './agentMcpBridge';

const index = process.argv.indexOf('--connection');
if (index < 0 || !process.argv[index + 1]) {
    process.stderr.write('Usage: node agent-mcp.cjs --connection <KOT connection.json>\n'); process.exitCode = 1;
} else {
    void runAgentMcpBridge(process.argv[index + 1], process.stdin, process.stdout).catch(() => {
        process.stderr.write('KOT MCP bridge stopped. Start the KOT agent server in VS Code and reconnect.\n'); process.exitCode = 1;
    });
}
