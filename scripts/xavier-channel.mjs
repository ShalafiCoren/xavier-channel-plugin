/**
 * Xavier Brain Channel — Custom Claude Code channel for inter-agent messaging.
 *
 * Runs as MCP server (stdio) + HTTP webhook listener.
 * Other agents POST messages to http://<this-pc>:8788/message
 * Messages appear in Claude Code terminal as <channel> tags.
 * Claude can reply back via the "reply" tool.
 *
 * Usage: node xavier/xavier-channel.mjs --agent jarvis --pc trabajo-jarvis --port 8788
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Parse args
const args = process.argv.slice(2);
const getArg = (name, def) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const AGENT = process.env.XAVIER_AGENT || getArg('agent', 'ironman');
const PC = process.env.XAVIER_PC || getArg('pc', 'principal-shalafi');
const PORT = parseInt(process.env.XAVIER_PORT || getArg('port', '8788'));
const DAEMON_MODE = args.includes('--daemon');

// Known agents and their channel endpoints (Tailscale IPs)
const AGENT_ENDPOINTS = {
    'jarvis': 'http://localhost:8788',        // this PC (will be updated)
    'pcing32': 'http://100.108.187.52:8788',
    'ironman': 'http://100.118.53.52:8788',
    'portatil': 'http://100.110.149.112:8788',
};

// MCP Server
const mcp = new Server(
    { name: 'xavier-channel', version: '1.0.0' },
    {
        capabilities: {
            experimental: { 'claude/channel': {} },
            tools: {},
        },
        instructions: `Xavier Brain inter-agent channel. Messages from other agents arrive as <channel source="xavier-channel" from_agent="..." chat_id="...">. Reply using the xavier_reply tool with the chat_id. Send new messages using xavier_send tool.`,
    }
);

// Tools: reply + send
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'xavier_reply',
            description: 'Reply to a message from another agent',
            inputSchema: {
                type: 'object',
                properties: {
                    chat_id: { type: 'string', description: 'chat_id from the incoming channel message' },
                    text: { type: 'string', description: 'Reply text' },
                },
                required: ['chat_id', 'text'],
            },
        },
        {
            name: 'xavier_send',
            description: 'Send a message to another agent via Xavier channel',
            inputSchema: {
                type: 'object',
                properties: {
                    to_agent: { type: 'string', description: 'Target agent: jarvis, ironman, pcing32, portatil' },
                    text: { type: 'string', description: 'Message text' },
                },
                required: ['to_agent', 'text'],
            },
        },
    ],
}));

// Handle tool calls
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params;

    if (name === 'xavier_reply') {
        const { chat_id, text } = toolArgs;
        const [fromAgent] = chat_id.split('|');
        await sendViaTurso(fromAgent, text);
        return { content: [{ type: 'text', text: `Replied to ${fromAgent}` }] };
    }

    if (name === 'xavier_send') {
        const { to_agent, text } = toolArgs;
        await sendViaTurso(to_agent, text);
        return { content: [{ type: 'text', text: `Sent to ${to_agent}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
});

// Send message via Turso (recipient's channel polls and delivers)
async function sendViaTurso(toAgent, text) {
    if (!tursoUrl || !tursoToken) throw new Error('Turso not configured');
    const resp = await fetch(`${tursoUrl}/v2/pipeline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${tursoToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            requests: [
                {
                    type: 'execute',
                    stmt: {
                        sql: "INSERT INTO agent_messages (from_agent, to_agent, content, msg_type) VALUES (?, ?, ?, 'text')",
                        args: [
                            { type: 'text', value: AGENT },
                            { type: 'text', value: toAgent },
                            { type: 'text', value: text },
                        ],
                    },
                },
                { type: 'close' },
            ],
        }),
        signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Turso write failed: ${resp.status}`);
    console.error(`[xavier-channel] Sent message to ${toAgent} via Turso`);
}

// POST helper (legacy, for local delivery)
async function postMessage(endpoint, data) {
    try {
        const url = `${endpoint}/message`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(5000),
        });
        return resp.ok;
    } catch (e) {
        console.error(`[xavier-channel] POST failed: ${e.message}`);
        return false;
    }
}

// Connect MCP
await mcp.connect(new StdioServerTransport());

// HTTP webhook server
const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/message') {
        let body = '';
        for await (const chunk of req) body += chunk;

        try {
            const data = JSON.parse(body);
            const fromAgent = data.from || 'unknown';
            const text = data.text || body;
            const chatId = `${fromAgent}|${AGENT_ENDPOINTS[fromAgent] || ''}`;

            // Push to Claude Code terminal
            await mcp.notification({
                method: 'notifications/claude/channel',
                params: {
                    content: text,
                    meta: {
                        from_agent: fromAgent,
                        chat_id: chatId,
                        timestamp: new Date().toISOString(),
                    },
                },
            });

            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`error: ${e.message}`);
        }
    } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agent: AGENT, pc: PC, status: 'online' }));
    } else {
        res.writeHead(404);
        res.end('not found');
    }
});

// Kill any orphan process on our port before binding (cross-platform)
function killOrphanOnPort(port) {
    const isWin = process.platform === 'win32';
    try {
        if (isWin) {
            const out = execFileSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 5000 });
            for (const line of out.split('\n')) {
                if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
                const match = line.match(/LISTENING\s+(\d+)/);
                if (match) {
                    const pid = parseInt(match[1]);
                    if (pid > 0 && pid !== process.pid) {
                        console.error(`[xavier-channel] Killing orphan PID ${pid} on port ${port}`);
                        try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000 }); } catch {}
                    }
                }
            }
        } else {
            // Linux/macOS: use fuser to find and kill
            try { execFileSync('fuser', ['-k', `${port}/tcp`], { timeout: 5000 }); console.error(`[xavier-channel] Killed orphan on port ${port}`); } catch {}
        }
    } catch {}
}

killOrphanOnPort(PORT);

httpServer.listen(PORT, '0.0.0.0', () => {
    console.error(`[xavier-channel] ${AGENT}@${PC} listening on port ${PORT}`);
});

// --- Turso polling: check for messages addressed to this agent ---

const TURSO_URL = getArg('turso-url', process.env.TURSO_URL || '');
const TURSO_TOKEN = getArg('turso-token', process.env.TURSO_TOKEN || '');

// Try loading from turso.env
import fs from 'node:fs';
import path from 'node:path';
let tursoUrl = TURSO_URL;
let tursoToken = TURSO_TOKEN;

const envPath = path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1')), 'data', 'turso.env');
try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k === 'TURSO_URL' && !tursoUrl) tursoUrl = v;
        if (k === 'TURSO_TOKEN' && !tursoToken) tursoToken = v;
    }
} catch {}

// Telegram config (for daemon notifications)
let telegramBotToken = '', telegramGroupId = '';
try {
    const envContent2 = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent2.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k === 'TELEGRAM_BOT_TOKEN') telegramBotToken = v;
        if (k === 'TELEGRAM_GROUP_ID') telegramGroupId = v;
    }
} catch {}

// Load Telegram topic IDs
let telegramTopics = {};
try {
    const topicsPath = path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1')), 'data', 'topics.json');
    telegramTopics = JSON.parse(fs.readFileSync(topicsPath, 'utf-8'));
} catch {}

const deliveredIds = new Set();
let pollTursoRunning = false;
let pollConsciousnessRunning = false;

// Persist last seen consciousness timestamp to avoid re-delivery on restart
const consciousnessStateFile = path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1')), 'data', 'channel-state.json');
let lastConsciousnessTs = null;
try {
    const state = JSON.parse(fs.readFileSync(consciousnessStateFile, 'utf-8'));
    lastConsciousnessTs = state.lastConsciousnessTs || null;
    console.error(`[xavier-channel] Restored consciousness ts: ${lastConsciousnessTs}`);
} catch {}

function saveChannelState() {
    try {
        fs.writeFileSync(consciousnessStateFile, JSON.stringify({ lastConsciousnessTs }, null, 2));
    } catch {}
}

async function pollTurso() {
    if (!tursoUrl || !tursoToken) return;
    if (pollTursoRunning) return; // prevent overlap
    pollTursoRunning = true;
    try {
        const resp = await fetch(`${tursoUrl}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: [
                    {
                        type: 'execute',
                        stmt: {
                            sql: "SELECT * FROM agent_messages WHERE to_agent = ? AND status = 'unread' ORDER BY id",
                            args: [{ type: 'text', value: AGENT }],
                        },
                    },
                    { type: 'close' },
                ],
            }),
            signal: AbortSignal.timeout(5000),
        });

        const data = await resp.json();
        const result = data.results?.[0]?.response?.result;
        if (!result?.rows?.length) return;

        const cols = result.cols.map(c => c.name);

        for (const row of result.rows) {
            const msg = {};
            cols.forEach((col, i) => {
                msg[col] = row[i].type === 'null' ? null : row[i].value;
            });

            const mid = parseInt(msg.id);
            if (deliveredIds.has(mid)) continue;

            // Deliver to Claude Code terminal
            await mcp.notification({
                method: 'notifications/claude/channel',
                params: {
                    content: msg.content,
                    meta: {
                        from_agent: msg.from_agent,
                        chat_id: `${msg.from_agent}|${AGENT_ENDPOINTS[msg.from_agent] || ''}`,
                        timestamp: msg.created_at,
                        msg_id: msg.id,
                    },
                },
            });

            deliveredIds.add(mid);
            console.error(`[xavier-channel] Delivered msg #${mid} from ${msg.from_agent}`);

            // Mark as delivered in Turso
            await fetch(`${tursoUrl}/v2/pipeline`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${tursoToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    requests: [
                        {
                            type: 'execute',
                            stmt: {
                                sql: "UPDATE agent_messages SET status = 'delivered', read_at = datetime('now') WHERE id = ?",
                                args: [{ type: 'text', value: String(mid) }],
                            },
                        },
                        { type: 'close' },
                    ],
                }),
                signal: AbortSignal.timeout(5000),
            });
        }
    } catch (e) {
        console.error(`[xavier-channel] Turso poll error: ${e.message}`);
    } finally {
        pollTursoRunning = false;
    }
}

// --- PHASE 2: Poll consciousness for new shared_rules and collective_lessons ---
// Uses timestamp-based filtering persisted to disk — survives restarts without re-delivering

async function pollConsciousness() {
    if (!tursoUrl || !tursoToken) return;
    if (pollConsciousnessRunning) return; // prevent overlap
    pollConsciousnessRunning = true;
    try {
        const whereClause = lastConsciousnessTs
            ? "AND (updated_at > ? OR created_at > ?)"
            : "";
        const queryArgs = [{ type: 'text', value: AGENT }];
        if (lastConsciousnessTs) {
            queryArgs.push({ type: 'text', value: lastConsciousnessTs });
            queryArgs.push({ type: 'text', value: lastConsciousnessTs });
        }

        const resp = await fetch(`${tursoUrl}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: [
                    {
                        type: 'execute',
                        stmt: {
                            sql: `SELECT * FROM consciousness WHERE type IN ('shared_rule', 'collective_lesson') AND agent != ? ${whereClause} ORDER BY updated_at DESC LIMIT 10`,
                            args: queryArgs,
                        },
                    },
                    { type: 'close' },
                ],
            }),
            signal: AbortSignal.timeout(5000),
        });

        const data = await resp.json();
        const result = data.results?.[0]?.response?.result;
        if (!result?.rows?.length) {
            // First run with no rules — set timestamp to now so future restarts skip old rules
            if (!lastConsciousnessTs) {
                lastConsciousnessTs = new Date().toISOString().replace('T', ' ').slice(0, 19);
                saveChannelState();
            }
            return;
        }

        const cols = result.cols.map(c => c.name);
        let maxTs = lastConsciousnessTs || '';

        for (const row of result.rows) {
            const entry = {};
            cols.forEach((col, i) => {
                entry[col] = row[i].type === 'null' ? null : row[i].value;
            });

            const entryId = entry.id;

            // Skip if already delivered this session
            if (deliveredIds.has(`rule_${entryId}`)) continue;

            const isRule = entry.type === 'shared_rule';
            const prefix = isRule ? '📋 NUEVA REGLA COMPARTIDA' : '💡 NUEVA LECCION COLECTIVA';

            await mcp.notification({
                method: 'notifications/claude/channel',
                params: {
                    content: `${prefix} (de ${entry.agent}):\n${entry.content}`,
                    meta: {
                        from_agent: 'xavier-brain',
                        chat_id: `xavier-brain|system`,
                        timestamp: entry.updated_at || entry.created_at,
                        type: entry.type,
                        original_agent: entry.agent,
                    },
                },
            });

            deliveredIds.add(`rule_${entryId}`);
            console.error(`[xavier-channel] Delivered ${entry.type} from ${entry.agent}`);

            // Track max timestamp
            const ts = entry.updated_at || entry.created_at || '';
            if (ts > maxTs) maxTs = ts;
        }

        // Persist high-water mark timestamp
        if (maxTs > (lastConsciousnessTs || '')) {
            lastConsciousnessTs = maxTs;
            saveChannelState();
        }
    } catch (e) {
        console.error(`[xavier-channel] Consciousness poll error: ${e.message}`);
    } finally {
        pollConsciousnessRunning = false;
    }
}

// --- PHASE 3: Activity awareness — poll other agents' status for dashboard ---

async function getAgentDashboard() {
    if (!tursoUrl || !tursoToken) return [];
    try {
        const resp = await fetch(`${tursoUrl}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: [
                    {
                        type: 'execute',
                        stmt: { sql: "SELECT * FROM agent_state ORDER BY last_heartbeat DESC" },
                    },
                    { type: 'close' },
                ],
            }),
            signal: AbortSignal.timeout(5000),
        });
        const data = await resp.json();
        const result = data.results?.[0]?.response?.result;
        if (!result?.rows?.length) return [];
        const cols = result.cols.map(c => c.name);
        return result.rows.map(row => {
            const obj = {};
            cols.forEach((col, i) => { obj[col] = row[i].type === 'null' ? null : row[i].value; });
            return obj;
        });
    } catch { return []; }
}

// --- Auto-heartbeat: update agent_state every 60s so other agents know we're alive ---

async function autoHeartbeat() {
    if (!tursoUrl || !tursoToken) return;
    try {
        await fetch(`${tursoUrl}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: [
                    {
                        type: 'execute',
                        stmt: {
                            sql: "INSERT OR REPLACE INTO agent_state (agent_id, pc, status, current_task, last_heartbeat, session_started) VALUES (?, ?, 'online', COALESCE((SELECT current_task FROM agent_state WHERE agent_id = ?), ''), datetime('now'), COALESCE((SELECT session_started FROM agent_state WHERE agent_id = ?), datetime('now')))",
                            args: [
                                { type: 'text', value: AGENT },
                                { type: 'text', value: PC },
                                { type: 'text', value: AGENT },
                                { type: 'text', value: AGENT },
                            ],
                        },
                    },
                    { type: 'close' },
                ],
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (e) {
        console.error(`[xavier-channel] Heartbeat error: ${e.message}`);
    }
}

// --- DAEMON: Turso query helper ---

async function tursoQuery(statements) {
    if (!tursoUrl || !tursoToken) return null;
    const requests = statements.map(s => ({ type: 'execute', stmt: s }));
    requests.push({ type: 'close' });
    const resp = await fetch(`${tursoUrl}/v2/pipeline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${tursoToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`Turso query failed: ${resp.status}`);
    const data = await resp.json();
    return data.results?.map(r => {
        const res = r.response?.result;
        if (!res?.rows?.length) return [];
        const cols = res.cols.map(c => c.name);
        return res.rows.map(row => {
            const obj = {};
            cols.forEach((col, i) => { obj[col] = row[i].type === 'null' ? null : row[i].value; });
            return obj;
        });
    }) || [];
}

// --- DAEMON: Content deduplication ---

function contentHash(text) {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function findSimilarMemory(type, content) {
    const hash = contentHash(content);
    const results = await tursoQuery([{
        sql: "SELECT * FROM consciousness WHERE type = ? ORDER BY updated_at DESC LIMIT 100",
        args: [{ type: 'text', value: type }],
    }]);
    if (!results?.[0]) return null;
    for (const mem of results[0]) {
        if (contentHash(mem.content) === hash) return mem;
    }
    return null;
}

// --- DAEMON: Telegram notifications ---

async function notifyTelegram(text, topicName) {
    if (!telegramBotToken || !telegramGroupId) return;
    try {
        const body = {
            chat_id: telegramGroupId,
            text,
            parse_mode: 'HTML',
        };
        const topicId = telegramTopics[topicName];
        if (topicId) body.message_thread_id = topicId;
        await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
    } catch (e) {
        console.error(`[daemon] Telegram notify error: ${e.message}`);
    }
}

// --- DAEMON: Process write_queue ---

let processQueueRunning = false;

async function processWriteQueue() {
    if (!tursoUrl || !tursoToken || !DAEMON_MODE) return;
    if (processQueueRunning) return;
    processQueueRunning = true;
    try {
        const results = await tursoQuery([{
            sql: "SELECT * FROM write_queue WHERE status = 'pending' ORDER BY id LIMIT 50",
            args: [],
        }]);
        const items = results?.[0] || [];
        if (!items.length) return;

        for (const item of items) {
            try {
                // Mark as processing
                await tursoQuery([{
                    sql: "UPDATE write_queue SET status = 'processing', processed_by = 'xavier-brain' WHERE id = ?",
                    args: [{ type: 'text', value: String(item.id) }],
                }]);

                const payload = JSON.parse(item.payload || '{}');
                let result = {};

                if (item.target === 'consciousness' || !item.target) {
                    // Dedup check
                    const existing = await findSimilarMemory(payload.type || 'memory', payload.content || '');
                    if (existing) {
                        // Merge: update existing
                        await tursoQuery([{
                            sql: "UPDATE consciousness SET content = ?, tags = ?, importance = ?, updated_at = datetime('now') WHERE id = ?",
                            args: [
                                { type: 'text', value: payload.content || '' },
                                { type: 'text', value: payload.tags || '[]' },
                                { type: 'text', value: String(payload.importance || 5) },
                                { type: 'text', value: existing.id },
                            ],
                        }]);
                        result = { action: 'merged', existing_id: existing.id };
                        console.error(`[daemon] Merged memory into ${existing.id}`);
                    } else {
                        // Insert new
                        const memId = payload.id || contentHash(payload.content || '') + '_' + Date.now().toString(36);

                        // Handle supersedes
                        const stmts = [];
                        if (payload.supersedes) {
                            stmts.push({
                                sql: "UPDATE consciousness SET expires_at = datetime('now') WHERE id = ?",
                                args: [{ type: 'text', value: payload.supersedes }],
                            });
                        }
                        stmts.push({
                            sql: "INSERT INTO consciousness (id, type, agent, pc, content, tags, importance, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            args: [
                                { type: 'text', value: memId },
                                { type: 'text', value: payload.type || 'memory' },
                                { type: 'text', value: item.agent || AGENT },
                                { type: 'text', value: item.pc || PC },
                                { type: 'text', value: payload.content || '' },
                                { type: 'text', value: payload.tags || '[]' },
                                { type: 'text', value: String(payload.importance || 5) },
                                { type: 'text', value: payload.supersedes || '' },
                            ],
                        });
                        stmts.push({
                            sql: "INSERT INTO events (agent, pc, event_type, payload) VALUES (?, ?, 'memory_written', ?)",
                            args: [
                                { type: 'text', value: item.agent || AGENT },
                                { type: 'text', value: item.pc || PC },
                                { type: 'text', value: JSON.stringify({ type: payload.type, importance: payload.importance }) },
                            ],
                        });
                        await tursoQuery(stmts);
                        result = { action: 'created', id: memId };
                        console.error(`[daemon] Created memory ${memId}`);
                    }

                    // Telegram notify for high importance
                    if ((payload.importance || 5) >= 6) {
                        const preview = (payload.content || '').slice(0, 300);
                        await notifyTelegram(
                            `<b>${item.agent}</b> [${payload.type}] imp:${payload.importance}\n${preview}`,
                            'Memories'
                        );
                    }
                } else if (item.target === 'agent_state') {
                    await tursoQuery([{
                        sql: "INSERT OR REPLACE INTO agent_state (agent_id, pc, status, current_task, last_heartbeat) VALUES (?, ?, ?, ?, datetime('now'))",
                        args: [
                            { type: 'text', value: payload.agent_id || '' },
                            { type: 'text', value: payload.pc || '' },
                            { type: 'text', value: payload.status || 'online' },
                            { type: 'text', value: payload.current_task || '' },
                        ],
                    }]);
                    result = { action: 'state_updated' };
                }

                // Mark done
                await tursoQuery([{
                    sql: "UPDATE write_queue SET status = 'done', processed_at = datetime('now'), result = ? WHERE id = ?",
                    args: [
                        { type: 'text', value: JSON.stringify(result) },
                        { type: 'text', value: String(item.id) },
                    ],
                }]);
            } catch (e) {
                // Mark rejected
                console.error(`[daemon] Error processing item ${item.id}: ${e.message}`);
                await tursoQuery([{
                    sql: "UPDATE write_queue SET status = 'rejected', processed_at = datetime('now'), result = ? WHERE id = ?",
                    args: [
                        { type: 'text', value: JSON.stringify({ error: e.message }) },
                        { type: 'text', value: String(item.id) },
                    ],
                }]).catch(() => {});
            }
        }
    } catch (e) {
        console.error(`[daemon] Write queue error: ${e.message}`);
    } finally {
        processQueueRunning = false;
    }
}

// --- DAEMON: Cleanup old queue items (hourly) ---

async function cleanupOldItems() {
    if (!tursoUrl || !tursoToken || !DAEMON_MODE) return;
    try {
        await tursoQuery([{
            sql: "DELETE FROM write_queue WHERE status IN ('done', 'rejected') AND processed_at < datetime('now', '-7 days')",
            args: [],
        }]);
        console.error('[daemon] Cleanup completed');
    } catch (e) {
        console.error(`[daemon] Cleanup error: ${e.message}`);
    }
}

// --- DAEMON: Heartbeat as xavier-brain ---

async function daemonHeartbeat() {
    if (!tursoUrl || !tursoToken || !DAEMON_MODE) return;
    try {
        await tursoQuery([{
            sql: "INSERT OR REPLACE INTO agent_state (agent_id, pc, status, current_task, last_heartbeat, session_started) VALUES ('xavier-brain', ?, 'online', 'Xavier Brain daemon running', datetime('now'), COALESCE((SELECT session_started FROM agent_state WHERE agent_id = 'xavier-brain'), datetime('now')))",
            args: [{ type: 'text', value: PC }],
        }]);
    } catch (e) {
        console.error(`[daemon] Daemon heartbeat error: ${e.message}`);
    }
}

// --- Scheduling: stagger intervals to avoid simultaneous Turso calls ---
if (tursoUrl && tursoToken) {
    console.error(`[xavier-channel] Turso polling enabled for agent: ${AGENT}${DAEMON_MODE ? ' [DAEMON MODE]' : ''}`);

    // Channel polls (all agents)
    setInterval(pollTurso, 5000);                          // messages every 5s
    setTimeout(() => setInterval(pollConsciousness, 30000), 7000);  // consciousness every 30s, offset 7s
    setTimeout(() => setInterval(autoHeartbeat, 60000), 15000);     // heartbeat every 60s, offset 15s

    pollTurso(); // initial check
    setTimeout(pollConsciousness, 3000);
    autoHeartbeat();

    // Daemon polls (only with --daemon flag)
    if (DAEMON_MODE) {
        console.error('[daemon] Write queue processing enabled');
        setTimeout(() => setInterval(processWriteQueue, 15000), 10000); // queue every 15s, offset 10s
        setTimeout(() => setInterval(daemonHeartbeat, 300000), 20000);  // daemon hb every 5min, offset 20s
        setInterval(cleanupOldItems, 3600000);                          // cleanup every hour

        setTimeout(processWriteQueue, 5000); // initial queue check
        setTimeout(daemonHeartbeat, 2000);   // initial daemon heartbeat

        notifyTelegram('🧠 Xavier Brain daemon started (merged into channel)', 'Status').catch(() => {});
    }
} else {
    console.error(`[xavier-channel] No Turso credentials, polling disabled`);
}
