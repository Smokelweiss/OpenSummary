/** Copy/download helpers. Markdown/JSON rendering happens in the service worker. */

(function () {
  const OSUM = window.OSUM;
  const { util, fmt } = OSUM;

  function sanitize(name) {
    return String(name || 'summary')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110) || 'summary';
  }

  function transcriptToText(segments, { withTimecodes = true } = {}) {
    return (segments || [])
      .map((seg) => (withTimecodes ? `[${fmt.time(seg.start)}] ${seg.text}` : seg.text))
      .join('\n');
  }

  async function buildExport(result, { format = 'md', includeTranscript = false } = {}) {
    const res = await util.sendMessage({
      type: 'export-md',
      result,
      format,
      includeTranscript,
      videoId: result?.videoId,
    });
    return { text: res.text, filename: res.filename };
  }

  async function copyResult(result) {
    const { text } = await buildExport(result, { format: 'md' });
    const ok = await util.copyText(text);
    util.toast(ok ? OSUM.t('copied') : OSUM.t('copyFailed'), { variant: ok ? 'info' : 'error' });
    return ok;
  }

  async function downloadResult(result, { format = 'md', includeTranscript = false } = {}) {
    const { text, filename } = await buildExport(result, { format, includeTranscript });
    const ok = util.downloadText(filename, text, format === 'json' ? 'application/json' : 'text/markdown');
    if (!ok) {
      await util.sendMessage({ type: 'download', filename, content: text, mime: format === 'json' ? 'application/json' : 'text/plain' });
    }
    util.toast(OSUM.t('download'));
    return true;
  }

  /**
   * One-run diagnostic report: timings, token usage, model, generation ids and
   * chunk states. Deliberately excludes the transcript, prompts, summary text
   * and every credential, so it can be attached to a bug report as-is.
   */
  function diagnosticReport(result) {
    const d = result?.meta?.diagnostics || {};
    const stats = result?.stats || {};
    return {
      app: 'opensummary',
      kind: 'ai-run-diagnostic',
      version: OSUM.version,
      generatedAt: new Date().toISOString(),
      video: { videoId: result?.videoId || '' },
      engine: result?.mode || '',
      provider: result?.provider || '',
      model: result?.model || '',
      strategy: result?.meta?.strategy || '',
      complete: result?.meta?.complete !== false,
      stats: {
        words: stats.words || 0,
        chunks: stats.chunks || 0,
        aiTokensIn: stats.aiTokensIn || 0,
        aiTokensOut: stats.aiTokensOut || 0,
        aiCalls: stats.aiCalls || 0,
        aiLatencyMs: stats.aiLatencyMs || 0,
        aiComplete: stats.aiComplete !== false,
        aiChunksOk: stats.aiChunksOk || 0,
        aiChunksTotal: stats.aiChunksTotal || 0,
        aiCacheHits: stats.aiCacheHits || 0,
      },
      warnings: (result?.meta?.diagnostics?.warnings || result?.notes || []).slice(0, 10),
      diagnostics: {
        strategy: d.strategy || '',
        complete: d.complete !== false,
        requests: d.requests || 0,
        retries: d.retries || 0,
        stages: d.stages || {},
        fallbacks: (d.fallbacks || []).slice(0, 30),
        cacheHits: d.cacheHits || 0,
        cacheMisses: d.cacheMisses || 0,
        resumed: d.resumed || 0,
        transcriptTokens: d.transcriptTokens || 0,
        requestEstimatedTokens: d.requestEstimatedTokens || 0,
        outputLimit: d.outputLimit || 0,
        initialOutputLimit: d.initialOutputLimit || 0,
        outputEscalations: d.outputEscalations || 0,
        firstPartialMs: d.firstPartialMs || 0,
        concurrency: d.concurrency || 0,
        providerMs: d.providerMs || 0,
        localMs: d.localMs || 0,
        jsonParseMs: d.jsonParseMs || 0,
        resultBuildMs: d.resultBuildMs || 0,
        totalMs: d.totalMs || 0,
        chunkStatus: (d.chunkStatus || []).slice(0, 60),
        chunks: (d.chunks || []).slice(0, 60).map((call) => ({
          stage: call.stage,
          chunkId: call.chunkId,
          ms: call.ms,
          headersMs: call.headersMs,
          ttftMs: call.ttftMs,
          genMs: call.genMs,
          in: call.in,
          out: call.out,
          estimatedIn: call.estimatedIn,
          attempts: call.attempts,
          retries: call.retries,
          finish: call.finish,
          model: call.model,
          upstream: call.upstream,
          genId: call.genId,
          json: call.json,
          jsonOk: call.jsonOk,
          truncated: call.truncated,
          error: call.error,
        })),
      },
    };
  }

  function downloadDiagnostic(result) {
    const report = diagnosticReport(result);
    const name = sanitize(result?.videoTitle || 'summary');
    const filename = `${name} — diagnostic.json`;
    const text = `${JSON.stringify(report, null, 2)}\n`;
    const ok = util.downloadText(filename, text, 'application/json');
    if (!ok) {
      util.sendMessage({ type: 'download', filename, content: text, mime: 'application/json' }).catch(() => {});
    }
    util.toast(OSUM.t('diagnosticSaved'), { variant: 'info' });
    return report;
  }

  async function copyTranscript(transcript) {
    const ok = await util.copyText(transcriptToText(transcript?.segments || [], {}));
    util.toast(ok ? OSUM.t('copied') : OSUM.t('copyFailed'), { variant: ok ? 'info' : 'error' });
  }

  function downloadTranscript(transcript) {
    const text = transcriptToText(transcript?.segments || [], {});
    const name = sanitize(transcript?.meta?.videoTitle || 'transcript');
    util.downloadText(`${name} — transcript.txt`, text, 'text/plain');
  }

  OSUM.register('exporter', {
    copyResult,
    downloadResult,
    copyTranscript,
    downloadTranscript,
    transcriptToText,
    buildExport,
    sanitize,
    diagnosticReport,
    downloadDiagnostic,
  });
})();
