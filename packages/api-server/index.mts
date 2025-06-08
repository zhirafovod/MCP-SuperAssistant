import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(bodyParser.json());

interface PendingRequest {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const sseClients = new Set<express.Response>();
const pendingRequests = new Map<string, PendingRequest>();

app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcast(event: unknown) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

app.post('/v1/chat/completions', (req, res) => {
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'invalid request' });
    return;
  }
  const id = randomUUID();
  broadcast({ type: 'CHAT_COMPLETION_REQUEST', id, messages });

  const timeout = setTimeout(() => {
    pendingRequests.delete(id);
    res.status(504).json({ error: 'timeout' });
  }, 30000);

  pendingRequests.set(id, {
    resolve(content) {
      clearTimeout(timeout);
      res.json({ id, choices: [{ message: { role: 'assistant', content } }] });
    },
    reject(err) {
      clearTimeout(timeout);
      res.status(500).json({ error: err.message });
    },
    timeout,
  });
});

app.post('/v1/response', (req, res) => {
  const { id, content } = req.body ?? {};
  const pending = pendingRequests.get(id);
  if (!pending) {
    res.status(400).json({ error: 'unknown id' });
    return;
  }
  pendingRequests.delete(id);
  pending.resolve(String(content ?? ''));
  res.json({ ok: true });
});

const port = 3000;
app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
