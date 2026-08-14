import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool
} from "@modelcontextprotocol/sdk/types.js";

// Definicja serwerów podrzędnych
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

        const client = new Client(
            { name: "mcp-lex-pl", version: "1.0.0" },
            { capabilities: {} }
        );
        
        await client.connect(transport);
        
        const toolsResponse: any = await client.request(
            { method: "tools/list" },
            ListToolsRequestSchema
        );
        
        const tools: Tool[] = toolsResponse.tools || [];
        
        for (const tool of tools) {
            toolToClientMap.set(tool.name, client);
        }
        
        clients.push({ name: sub.name, client, tools });
        process.stderr.write(`Pod-serwer ${sub.name} gotowy. Narzędzia: ${tools.map((t: any) => t.name).join(", ")}\n`);
    }
}

async function main() {
    process.stderr.write("Uruchamianie serwera agregującego Polskie Prawo...\n");
    await startSubServers();

    const server = new Server(
        { name: "mcp-lex-pl", version: "1.0.0" },
        {
            capabilities: { tools: {} },
            instructions: "Serwer agregujący (Meta-Server) dla polskich usług prawnych: Dziennik Ustaw/Monitor Polski (ISAP), Orzecznictwo (SAOS) i Rejestr Przedsiębiorców (KRS)."
        }
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
            return {
                isError: true,
                content: [{ type: "text", text: `Nieznane narzędzie: ${toolName}` }]
            };
        }
        
        return await targetClient.request(request, CallToolRequestSchema);
    });

    // --- Konfiguracja Express i SSE ---
    const app = express();
    app.use(cors());
    app.use(express.json());

    let activeTransport: SSEServerTransport | null = null;

    app.get("/sse", async (req, res) => {
        console.log("[HTTP] Nowe połączenie SSE nawiązane");
        activeTransport = new SSEServerTransport("/message", res);
        await server.connect(activeTransport);
    });

    app.post("/message", async (req, res) => {
        if (!activeTransport) {
            console.error("[HTTP] Błąd: Brak aktywnego połączenia SSE");
            res.status(503).json({ error: "Brak aktywnego połączenia SSE. Odwiedź najpierw endpoint /sse" });
            return;
        }
        
        try {
            await activeTransport.handlePostMessage(req, res);
        } catch (error) {
            console.error("[HTTP] Błąd podczas przetwarzania wiadomości:", error);
            res.status(500).json({ error: "Błąd wewnętrzny serwera podczas obsługi POST /message" });
        }
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`✅ mcp-lex-pl HTTP Server nasłuchuje na porcie ${PORT}`);
        console.log(`Endpoint SSE dla ClickUp: http://localhost:${PORT}/sse`);
        console.log(`Użyj 'npx ngrok http ${PORT}' by wystawić go do sieci!`);
        console.log(`======================================================\n`);
    });
}

main().catch((err) => {
    process.stderr.write(`Błąd krytyczny: ${err}\n`);
    process.exit(1);
});
