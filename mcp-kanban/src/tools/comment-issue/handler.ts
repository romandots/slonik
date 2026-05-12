import type { PlaneClient, PlaneComment } from '../../plane-client.js';
import type { TtlCache } from '../../cache.js';
import type { AgentIdentity } from '../../identity.js';
import { resolveProject } from '../project-resolver.js';
import { parseIssueRef } from '../get-issue/schema.js';
import { resolveIssueId } from '../update-issue/handler.js';
import type { CommentIssueInput } from './schema.js';

export interface CommentIssueResult {
  comment: PlaneComment;
  issue_id: string;
}

export async function commentIssue(deps: {
  plane: PlaneClient;
  cache: TtlCache;
  workspace: string;
  defaultProjectRef: string;
  allowedProjects: string[];
  identity: AgentIdentity;
  input: CommentIssueInput;
}): Promise<CommentIssueResult> {
  const parsed = parseIssueRef(deps.input.issue_id);
  const project = await resolveProject({
    plane: deps.plane,
    workspaceSlug: deps.workspace,
    ...(deps.input.project !== undefined
      ? { projectRef: deps.input.project }
      : parsed.kind === 'sequence' && parsed.identifier !== undefined
        ? { projectRef: parsed.identifier }
        : {}),
    defaultProjectRef: deps.defaultProjectRef,
    allowedProjects: deps.allowedProjects,
  });

  const issueId = await resolveIssueId(deps.plane, deps.workspace, project, parsed);
  const comment = await deps.plane.createIssueComment(deps.workspace, project.id, issueId, {
    comment_html: formatComment(deps.identity, deps.input.comment),
  });
  deps.cache.clear();
  return { comment, issue_id: issueId };
}

/** Все комментарии MCP начинаются с `[<role>]:` (SPEC §5.5). */
export function formatComment(identity: AgentIdentity, body: string): string {
  return `<p><strong>[${identity}]</strong>: ${sanitizeHtml(body)}</p>`;
}

// Whitelist inline-форматирующих тегов. Plane v1.3.0 рендерит HTML
// комментариев через TipTap/ProseMirror и сам режет script/style на своей
// стороне, но мы дополнительно вычищаем всё, что не из этого списка, на
// уровне MCP — defence in depth. Атрибуты разрешены только у `<a>`
// (`href`, `title`), и `href` обязан быть `http(s):` или `mailto:` —
// `javascript:` и `data:` блокируются.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'code', 'pre',
  'ul', 'ol', 'li',
  'a',
  'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const SAFE_URL = /^(https?:|mailto:)/i;

function sanitizeHtml(input: string): string {
  // 1) Удалить script/style/iframe/object/embed целиком (вместе с содержимым).
  const stripped = input.replace(
    /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // 2) Пройтись по всем оставшимся тегам — оставить только whitelist,
  //    очистить атрибуты, валидировать href.
  return stripped.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_m, rawTag: string, rest: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const isClose = _m.startsWith('</');
    if (isClose) return `</${tag}>`;
    if (tag === 'a') {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(rest);
      const url = href?.[2] ?? href?.[3];
      if (url !== undefined && SAFE_URL.test(url.trim())) {
        return `<a href="${url.replace(/"/g, '&quot;')}" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    return `<${tag}>`;
  });
}
