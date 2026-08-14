import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    CallToolResultSchema,
    Tool
} from "@modelcontextprotocol/sdk/types.js";

const SUB_SERVERS = [
    { name: "isap", bin: "mcp-isap" },
    { name: "saos", bin: "mcp-saos" },
    { name: "krs", bin: "mcp-krs" }
];

interface SubClient {
    name: string;
    client: Client;
    tools: Tool[];
}

const clients: SubClient[] = [];
const toolToClientMap = new Map<string, Client>();

async function startSubServers() {
    for (const sub of SUB_SERVERS) {
        process.stderr.write(`Uruchamianie pod-serwera: ${sub.name} (bin: ${sub.bin})...\n`);
        const transport = new StdioClientTransport({
            command: process.platform === "win32" ? "npx.cmd" : "npx",
            args: [sub.bin],
            stderr: "pipe"
        });
        
        transport.stderr?.on("data", (data: any) => {
            process.stderr.write(`[${sub.name} STDERR] ${data}`);
        });

        const client = new Client({ name: "mcp-lex-pl", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
        
        const toolsResponse: any = await client.request({ method: "tools/list" }, ListToolsResultSchema);
        const tools: Tool[] = toolsResponse.tools || [];
        for (const tool of tools) {
            toolToClientMap.set(tool.name, client);
        }
        
        clients.push({ name: sub.name, client, tools });
        process.stderr.write(`Pod-serwer ${sub.name} gotowy. Narzędzia: ${tools.map((t: any) => t.name).join(", ")}\n`);
    }
}

function createMcpServer(): Server {
    const server = new Server(
        { name: "mcp-lex-pl", version: "1.0.0" },
        { capabilities: { tools: {} }, instructions: "Serwer agregujący." }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const allTools: Tool[] = [];
        for (const sub of clients) {
            allTools.push(...sub.tools);
        }
        return { tools: allTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const targetClient = toolToClientMap.get(toolName);
        if (!targetClient) {
            return { isError: true, content: [{ type: "text", text: `Nieznane narzędzie: ${toolName}` }] };
        }
        return await targetClient.request({ method: "tools/call", params: request.params }, CallToolResultSchema);
    });

    return server;
}

async function main() {
    process.stderr.write("Uruchamianie serwera agregującego Polskie Prawo...\n");
    await startSubServers();

    const app = express();
    app.use(cors());
    // Nie używamy globalnie express.json(), bo SSEServerTransport sam wczytuje surowy stream w handlePostMessage

    const transports = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
        try {
            console.log("[HTTP] Nowe połączenie SSE nawiązane");
            const transport = new SSEServerTransport("/message", res);
            const server = createMcpServer();
            
            await server.connect(transport);
            transports.set(transport.sessionId, transport);

            res.on("close", () => {
                console.log(`[HTTP] Połączenie zamknięte dla sesji: ${transport.sessionId}`);
                transports.delete(transport.sessionId);
                server.close().catch(console.error);
            });
        } catch (err) {
            console.error("[HTTP] Błąd przy tworzeniu SSE:", err);
            res.status(500).end();
        }
    });

    app.post("/message", async (req, res) => {
        const sessionId = req.query.sessionId as string;
        if (!sessionId || !transports.has(sessionId)) {
            res.status(404).end("Brak aktywnej sesji (sessionId)");
            return;
        }

        const transport = transports.get(sessionId)!;
        try {
            await transport.handlePostMessage(req, res);
        } catch (error) {
            console.error("[HTTP] Błąd podczas przetwarzania wiadomości:", error);
            res.status(500).json({ error: "Błąd wewnętrzny serwera" });
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`✅ mcp-lex-pl HTTP Server nasłuchuje na porcie ${PORT}`);
        console.log(`Endpoint SSE dla ClickUp: http://localhost:${PORT}/sse`);
        console.log(`======================================================\n`);
    });
}

main().catch((err) => {
    process.stderr.write(`Błąd krytyczny: ${err}\n`);
    process.exit(1);
});
