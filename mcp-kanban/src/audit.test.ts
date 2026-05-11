import { describe, expect, it } from 'vitest';
import { AuditLog, hashInput, newTraceId } from './audit.js';

describe('AuditLog', () => {
  it('records and lists entries', () => {
    const log = new AuditLog({ path: ':memory:' });
    log.record({
      trace_id: newTraceId(),
      identity: 'developer-agent',
      tool: 'create_issue',
      input_hash: hashInput({ name: 'A' }),
      plane_request_id: null,
      outcome: 'success',
      error_code: null,
      event: null,
      issue_id: 'iss-1',
    });
    const rows = log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe('create_issue');
    log.close();
  });

  it('tryAcquireClaim is atomic — only the first wins', () => {
    const log = new AuditLog({ path: ':memory:' });
    const ok1 = log.tryAcquireClaim({
      issue_id: 'iss-1',
      identity: 'developer-agent',
      trace_id: newTraceId(),
    });
    const ok2 = log.tryAcquireClaim({
      issue_id: 'iss-1',
      identity: 'qa-agent',
      trace_id: newTraceId(),
    });
    expect(ok1).toBe(true);
    expect(ok2).toBe(false);
    expect(log.currentClaim('iss-1')?.identity).toBe('developer-agent');
    log.close();
  });

  it('releaseClaim returns false when identity does not match', () => {
    const log = new AuditLog({ path: ':memory:' });
    log.tryAcquireClaim({ issue_id: 'iss-2', identity: 'a', trace_id: newTraceId() });
    expect(log.releaseClaim({ issue_id: 'iss-2', identity: 'b' })).toBe(false);
    expect(log.releaseClaim({ issue_id: 'iss-2', identity: 'a' })).toBe(true);
    expect(log.currentClaim('iss-2')).toBeUndefined();
    log.close();
  });

  it('hashInput is stable across key order', () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
});
