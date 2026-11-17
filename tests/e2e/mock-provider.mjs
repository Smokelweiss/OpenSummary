/**
 * OpenAI-compatible SSE mock with three behaviours:
 *   hold    — send the first half, wait for `release()`, then send the rest;
 *   error   — send the first half, then an in-stream provider error;
 *   auth    — reject the request with HTTP 401 before any stream;
 *   verdict — answer with the one-line safety-classifier verdict (a wrong
 *             model route), then switch to `ok` so the retry succeeds.
 *
 * The state lives in this process (the harness and the browser share it), so
 * the scenario changes modes without any extra control endpoints.
 */
import { createServer } from 'node:http';

function sse(res, text) {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

/**
 * @param {{head: string, tail: string, log?: Function}} options
 */
export function createMockProvider({ head, tail, log = () => {} }) {
  const state = {
    mode: 'hold',
    released: false,
    requests: 0,
    verdicts: 0,
    promptSegments: 0,
    promptText: '',
    prompts: [],
  };
  let gate = null;
  let releaseGate = () => {};

  const resetGate = () => {
    state.released = false;
    gate = new Promise((resolve) => {
      releaseGate = () => {
        state.released = true;
        resolve();
      };
    });
  };
  resetGate();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"unknown route"}}');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      state.requests++;
      const body = Buffer.concat(chunks).toString('utf8');
      const stream = body.includes('"stream":true');
      // The whole request body lets the YouTube scenario prove that every
      // fetched caption segment reached the prompt, not just the panel. All
      // bodies are kept because a long video is split into several map chunks.
      state.promptText = body;
      state.prompts.push(body);
      // The pasted transcript must reach the provider, not just the panel.
      state.promptSegments = (body.match(/На шаге \d+/g) || []).length;
      log(`mock request ${state.requests}: stream=${stream}, mode=${state.mode}, segments=${state.promptSegments}`);

      if (state.mode === 'auth') {
        res.writeHead(401, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end('{"error":{"message":"Invalid API key"}}');
        return;
      }
      if (!stream) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"expected a streamed request"}}');
        return;
      }

      const waitForRelease = gate;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      if (state.mode === 'verdict') {
        // What a guard model answers when a free router sends it the request:
        // one line, no JSON, no content. The next attempt must be a real one.
        state.verdicts++;
        sse(res, 'User Safety: safe');
        res.write('data: [DONE]\n\n');
        res.end();
        state.mode = 'ok';
        return;
      }
      sse(res, head);
      if (state.mode === 'error') {
        // Enough time for the first validated item to render before the stream
        // breaks; the scenario still waits for the DOM, not for this timer.
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.write(`data: ${JSON.stringify({ error: { message: 'upstream died' } })}\n\n`);
        res.end();
        return;
      }
      if (state.mode === 'hold') await waitForRelease;
      sse(res, tail);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return {
    server,
    state,
    resetGate,
    release() {
      releaseGate();
    },
    setMode(mode) {
      state.mode = mode;
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
