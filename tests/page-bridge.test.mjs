/**
 * The page bridge runs inside YouTube's own world, so it is tested here in a
 * bare VM context: a fake window, a fake document and a fake fetch. What
 * matters is the contract with the content script — the page's own transcript
 * answer is captured and handed back, and a direct `get_panel` request is built
 * from the page's own params.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setInterval as realSetInterval, setTimeout as realSetTimeout, clearInterval as realClearInterval, clearTimeout as realClearTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it, assert, assertEqual } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src', 'content', 'page-bridge.js'), 'utf8');

const PANEL = {
  content: {
    engagementPanelSectionListRenderer: {
      content: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    macroMarkersPanelItemViewModel: {
                      item: {
                        timelineItemViewModel: {
                          contentItems: [
                            { transcriptSegmentViewModel: { timestamp: '0:01', simpleText: 'Первая строка' } },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

const PARAMS = 'CgtkUXc0dzlXZ1hjURIOQ2dBU0FtVnVHZ0ElM0QY';

function makeBridge({ fetchImpl } = {}) {
  const listeners = [];
  const posted = [];
  const fetchCalls = [];
  const window = {
    __osumPageBridge: false,
    ytcfg: {
      get: (key) =>
        ({
          INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261023.01.00', hl: 'en' } },
          INNERTUBE_CLIENT_VERSION: '2.20261023.01.00',
          VISITOR_DATA: 'visitor-1',
        })[key],
    },
    ytInitialData: { contents: [{ getTranscriptEndpoint: { params: PARAMS } }] },
    scrollTo() {},
    scrollBy() {},
    scrollY: 0,
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    postMessage(message) {
      if (!message || message.__osum !== 'request') {
        posted.push(message);
        return;
      }
      for (const handler of listeners.slice()) handler({ source: window, data: message });
    },
    fetch: (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return fetchImpl(String(url), options);
    },
  };
  const document = {
    documentElement: { lang: 'en', style: {}, removeAttribute() {}, hasAttribute: () => false },
    head: { appendChild() {} },
    querySelector: () => null,
  };
  class XMLHttpRequest {
    open() {}
    send() {}
    addEventListener() {}
  }
  const context = {
    window,
    document,
    location: { origin: 'https://www.youtube.com' },
    Element: class {
      scrollIntoView() {}
    },
    XMLHttpRequest,
    fetch: (...args) => window.fetch(...args),
    setTimeout: realSetTimeout,
    clearTimeout: realClearTimeout,
    AbortController,
    JSON,
    console,
  };
  vm.runInNewContext(SOURCE, context, { filename: 'page-bridge.js' });
  return { window, posted, fetchCalls };
}

function request(bridge, kind, extra = {}) {
  const id = `req-${Math.random().toString(36).slice(2)}`;
  bridge.window.postMessage({ __osum: 'request', id, kind, ...extra });
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = realSetInterval(() => {
      const hit = bridge.posted.find((m) => m && m.id === id);
      if (hit) {
        realClearInterval(timer);
        resolve(hit);
      } else if (Date.now() - started > 3000) {
        realClearInterval(timer);
        resolve(null);
      }
    }, 10);
  });
}

describe('page-world transcript bridge', () => {
  it('captures the panel’s own get_panel answer and hands it over', async () => {
    let started;
    const gate = new Promise((resolve) => {
      started = resolve;
    });
    const bridge = makeBridge({
      fetchImpl: () => {
        started();
        return Promise.resolve({
          ok: true,
          status: 200,
          clone() {
            return this;
          },
          json: async () => PANEL,
          text: async () => JSON.stringify(PANEL),
        });
      },
    });
    const pending = request(bridge, 'capture-transcript', { timeoutMs: 2000 });
    // YouTube's own request happens after the waiter is armed.
    bridge.window.fetch('/youtubei/v1/get_panel?prettyPrint=false', { method: 'POST' });
    await gate;
    const answer = await pending;
    assert(answer, 'the capture request must be answered');
    assertEqual(answer.captured, true);
    assertEqual(answer.json?.content?.engagementPanelSectionListRenderer !== undefined, true, 'the full JSON is returned');
  });

  it('returns captured:false instead of hanging when the page never asks', async () => {
    const bridge = makeBridge({ fetchImpl: () => new Promise(() => {}) });
    const answer = await request(bridge, 'capture-transcript', { timeoutMs: 1000 });
    assert(answer, 'a timeout must still answer');
    assertEqual(answer.captured, false);
  });

  it('asks get_panel directly with the page’s params and panel id', async () => {
    const bridge = makeBridge({
      fetchImpl: async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          clone() {
            return this;
          },
          json: async () => PANEL,
          text: async () => JSON.stringify(PANEL),
        }),
    });
    const answer = await request(bridge, 'get-panel');
    assert(answer?.ok, `the panel must be read: ${JSON.stringify(answer)}`);
    assert(answer.text.includes('transcriptSegmentViewModel'), 'the answer carries the transcript');
    const call = bridge.fetchCalls.find((c) => c.url.includes('/youtubei/v1/get_panel'));
    assert(call, 'a get_panel request must be made');
    const body = JSON.parse(call.options.body);
    assertEqual(body.params, PARAMS, 'the params come from the page data');
    assertEqual(body.panelId, 'PAmodern_transcript_view');
    assertEqual(body.context.client.visitorData, 'visitor-1');
    assertEqual(call.options.headers['x-goog-visitor-id'], 'visitor-1');
  });

  it('tries the legacy panel id and reports the last refusal', async () => {
    const bridge = makeBridge({
      fetchImpl: async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          clone() {
            return this;
          },
          json: async () => ({}),
          text: async () => '{"error":{"message":"Precondition check failed."}}',
        }),
    });
    const answer = await request(bridge, 'get-panel');
    assertEqual(answer.status, 400);
    const urls = bridge.fetchCalls.map((c) => c.url);
    assertEqual(urls.length, 2, 'both panel ids must be tried');
    const ids = bridge.fetchCalls.map((c) => JSON.parse(c.options.body).panelId);
    assertEqual(ids[1], 'engagement-panel-searchable-transcript');
  });
});
