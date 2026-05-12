import { describe, expect, it } from 'vitest';
import { commentIssue, formatComment } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('formatComment', () => {
  it('prefixes with [<identity>] and strips disallowed tags', () => {
    const out = formatComment('developer-agent', '<script>alert(1)</script>hi');
    expect(out).toContain('<strong>[developer-agent]</strong>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('hi');
  });

  it('preserves inline formatting whitelist (em / strong / code / a)', () => {
    const out = formatComment(
      'developer-agent',
      'moved to <em>Development</em>; see <a href="https://example.com">PR</a>',
    );
    expect(out).toContain('<em>Development</em>');
    expect(out).toContain('<a href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('drops unsafe href schemes (javascript:, data:)', () => {
    const out = formatComment('developer-agent', '<a href="javascript:alert(1)">x</a>');
    expect(out).toContain('<a>x</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips event-handler attributes from allowed tags', () => {
    const out = formatComment('developer-agent', '<strong onclick="x()">bold</strong>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).not.toContain('onclick');
  });
});

describe('commentIssue', () => {
  it('posts a prefixed comment', async () => {
    const world = newWorld();
    const { project } = seedAgentsWorkspace(world);
    const issue = addIssue(world, project.id, { name: 'A', state: 'st-To Do' });
    const plane = fakePlane(world);
    const r = await commentIssue({
      plane,
      cache: new TtlCache(),
      workspace: 'agents',
      defaultProjectRef: 'SLONK',
      allowedProjects: ['SLONK'],
      identity: 'qa-agent',
      input: { issue_id: issue.id, comment: 'tests are green' },
    });
    expect(r.comment.comment_html).toContain('[qa-agent]');
    expect(r.comment.comment_stripped).toContain('tests are green');
  });
});
