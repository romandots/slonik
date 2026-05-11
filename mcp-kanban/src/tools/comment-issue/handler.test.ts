import { describe, expect, it } from 'vitest';
import { commentIssue, formatComment } from './handler.js';
import { TtlCache } from '../../cache.js';
import { addIssue, fakePlane, newWorld, seedAgentsWorkspace } from '../test-fakes.js';

describe('formatComment', () => {
  it('prefixes with [<identity>] and escapes html', () => {
    const out = formatComment('developer-agent', '<script>alert(1)</script>');
    expect(out).toContain('<strong>[developer-agent]</strong>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
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
