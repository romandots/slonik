import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from './metrics.js';

describe('MetricsRegistry', () => {
  it('records a tool call as both counter and histogram', async () => {
    const m = new MetricsRegistry();
    m.recordTool({ tool: 'list_issues', outcome: 'success', durationSec: 0.123 });
    const text = await m.metricsText();
    expect(text).toContain('mcp_tool_calls_total{');
    expect(text).toContain('tool="list_issues"');
    expect(text).toContain('outcome="success"');
    expect(text).toContain('mcp_tool_duration_seconds_count{');
  });

  it('separates success vs error outcomes', async () => {
    const m = new MetricsRegistry();
    m.recordTool({ tool: 'get_issue', outcome: 'success', durationSec: 0.05 });
    m.recordTool({ tool: 'get_issue', outcome: 'error', durationSec: 0.04, errorCode: 'NOT_FOUND' });
    const text = await m.metricsText();
    expect(text).toMatch(/mcp_tool_calls_total\{[^}]*outcome="success"[^}]*\} 1/);
    expect(text).toMatch(/mcp_tool_calls_total\{[^}]*outcome="error"[^}]*error_code="NOT_FOUND"[^}]*\} 1/);
  });

  it('records plane errors by kind', async () => {
    const m = new MetricsRegistry();
    m.recordPlaneError('5xx');
    m.recordPlaneError('5xx');
    m.recordPlaneError('network');
    const text = await m.metricsText();
    expect(text).toMatch(/mcp_plane_errors_total\{[^}]*kind="5xx"[^}]*\} 2/);
    expect(text).toMatch(/mcp_plane_errors_total\{[^}]*kind="network"[^}]*\} 1/);
  });

  it('records rate-limit hits by scope+identity', async () => {
    const m = new MetricsRegistry();
    m.recordRateLimited('identity', 'developer-agent');
    const text = await m.metricsText();
    expect(text).toMatch(/mcp_rate_limited_total\{[^}]*scope="identity"[^}]*identity="developer-agent"[^}]*\} 1/);
  });

  it('exposes default node.js metrics', async () => {
    const m = new MetricsRegistry();
    const text = await m.metricsText();
    expect(text).toContain('process_cpu_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('content-type is Prometheus text exposition format', () => {
    const m = new MetricsRegistry();
    expect(m.contentType()).toMatch(/text\/plain.*version=0\.0\.4/);
  });
});
