import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

// SQLite-индекс git-привязок (SPEC §5.6). Источник правды — meta-блок
// внутри Plane-issue (см. `meta-block.ts`). Индекс существует только для
// быстрого `find_issues_by_git_ref` без обхода всех issues. При расхождении
// между Plane и индексом — индекс пересобирается из Plane (на v1
// rebuild-команды нет, но операции `link/unlink_git_ref` поддерживают
// индекс в синхронном состоянии).

export interface GitRefRow {
  workspace: string;
  project_identifier: string;
  issue_id: string;
  issue_key: string;
  repo_url: string;
  branch: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertGitRefArgs {
  workspace: string;
  project_identifier: string;
  issue_id: string;
  issue_key: string;
  repo_url: string;
  branch?: string;
  pr_url?: string;
  commit_sha?: string;
}

export interface RemoveGitRefArgs {
  issue_id: string;
  repo_url: string;
  commit_sha?: string;
}

export interface FindGitRefArgs {
  repo_url?: string;
  branch?: string;
  pr_url?: string;
  commit_sha?: string;
  limit?: number;
}

const EMPTY_COMMIT_SENTINEL = '';

export class GitRefsIndex {
  private readonly db: Database.Database;

  constructor(opts: { path: string }) {
    if (opts.path !== ':memory:') {
      mkdirSync(dirname(opts.path), { recursive: true });
    }
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS git_refs (
        workspace          TEXT NOT NULL,
        project_identifier TEXT NOT NULL,
        issue_id           TEXT NOT NULL,
        issue_key          TEXT NOT NULL,
        repo_url           TEXT NOT NULL,
        branch             TEXT,
        pr_url             TEXT,
        commit_sha         TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (issue_id, repo_url, commit_sha)
      );
      CREATE INDEX IF NOT EXISTS idx_git_refs_repo_commit
        ON git_refs (repo_url, commit_sha);
      CREATE INDEX IF NOT EXISTS idx_git_refs_repo_branch
        ON git_refs (repo_url, branch);
      CREATE INDEX IF NOT EXISTS idx_git_refs_pr
        ON git_refs (pr_url);
      CREATE INDEX IF NOT EXISTS idx_git_refs_issue
        ON git_refs (issue_id);
    `);
  }

  /**
   * Идемпотентный upsert по тройке (issue_id, repo_url, commit_sha).
   * Если коммит не задан — sentinel-строка `''`, что даёт ровно одну
   * "branch/PR" запись на пару (issue, repo).
   */
  upsert(args: UpsertGitRefArgs): void {
    const now = new Date().toISOString();
    const commitSha = args.commit_sha ?? EMPTY_COMMIT_SENTINEL;
    this.db
      .prepare(
        `INSERT INTO git_refs
           (workspace, project_identifier, issue_id, issue_key, repo_url,
            branch, pr_url, commit_sha, created_at, updated_at)
         VALUES
           (@workspace, @project_identifier, @issue_id, @issue_key, @repo_url,
            @branch, @pr_url, @commit_sha, @now, @now)
         ON CONFLICT (issue_id, repo_url, commit_sha) DO UPDATE SET
           branch     = COALESCE(excluded.branch, git_refs.branch),
           pr_url     = COALESCE(excluded.pr_url, git_refs.pr_url),
           workspace  = excluded.workspace,
           project_identifier = excluded.project_identifier,
           issue_key  = excluded.issue_key,
           updated_at = excluded.updated_at`,
      )
      .run({
        workspace: args.workspace,
        project_identifier: args.project_identifier,
        issue_id: args.issue_id,
        issue_key: args.issue_key,
        repo_url: args.repo_url,
        branch: args.branch ?? null,
        pr_url: args.pr_url ?? null,
        commit_sha: commitSha,
        now,
      });
  }

  /**
   * Удаляет запись(и). Если `commit_sha` задан — удаляется ровно строка
   * с этим коммитом; иначе — все записи `(issue_id, repo_url)`.
   * Возвращает число удалённых строк.
   */
  remove(args: RemoveGitRefArgs): number {
    if (args.commit_sha !== undefined) {
      const info = this.db
        .prepare(
          `DELETE FROM git_refs
            WHERE issue_id = @issue_id
              AND repo_url = @repo_url
              AND commit_sha = @commit_sha`,
        )
        .run({ ...args, commit_sha: args.commit_sha });
      return info.changes;
    }
    const info = this.db
      .prepare(`DELETE FROM git_refs WHERE issue_id = @issue_id AND repo_url = @repo_url`)
      .run(args);
    return info.changes;
  }

  /** Все записи для одного issue. Для diagnostic-вывода в `get_issue`. */
  listForIssue(issue_id: string): GitRefRow[] {
    return this.db
      .prepare(`SELECT * FROM git_refs WHERE issue_id = @issue_id ORDER BY created_at`)
      .all({ issue_id }) as GitRefRow[];
  }

  /**
   * Поиск по любым из (repo, branch, pr, commit). Все фильтры — equality,
   * AND-объединение. Хотя бы один фильтр обязателен; иначе вернёт пусто
   * (защита от случайного "достать всё").
   */
  find(args: FindGitRefArgs): GitRefRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (args.repo_url !== undefined) {
      conditions.push('repo_url = @repo_url');
      params['repo_url'] = args.repo_url;
    }
    if (args.branch !== undefined) {
      conditions.push('branch = @branch');
      params['branch'] = args.branch;
    }
    if (args.pr_url !== undefined) {
      conditions.push('pr_url = @pr_url');
      params['pr_url'] = args.pr_url;
    }
    if (args.commit_sha !== undefined) {
      conditions.push('commit_sha = @commit_sha');
      params['commit_sha'] = args.commit_sha;
    }
    if (conditions.length === 0) return [];
    params['limit'] = args.limit ?? 50;
    const sql = `SELECT * FROM git_refs
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT @limit`;
    return this.db.prepare(sql).all(params) as GitRefRow[];
  }

  close(): void {
    this.db.close();
  }
}

/** Нормализует sentinel `''` для commit_sha обратно в null для вывода в API. */
export function rowToPublic(row: GitRefRow): Omit<GitRefRow, 'commit_sha'> & { commit_sha: string | null } {
  return {
    ...row,
    commit_sha: row.commit_sha === EMPTY_COMMIT_SENTINEL ? null : row.commit_sha,
  };
}
