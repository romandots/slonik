import { describe, expect, it } from 'vitest';
import { IdentityStore } from './store.js';
import Database from 'better-sqlite3';

describe('IdentityStore', () => {
  it('upsert + get round-trip (SLONK-6: includes default_state + aliases)', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'developer-agent',
      email: 'developer-agent@slonk.local',
      plane_user_id: 'usr-1',
      mode: 'per_user',
      default_state: 'Development',
      state_aliases: ['Разработка', 'Coding'],
    });
    const m = store.get('developer-agent');
    expect(m?.plane_user_id).toBe('usr-1');
    expect(m?.mode).toBe('per_user');
    expect(m?.default_state).toBe('Development');
    expect(m?.state_aliases).toEqual(['Разработка', 'Coding']);
    expect(m?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    store.close();
  });

  it('upsert overwrites existing row (including state_aliases)', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'qa-agent',
      email: 'qa@slonk.local',
      plane_user_id: 'old',
      mode: 'per_user',
      default_state: 'Testing',
      state_aliases: ['QA'],
    });
    store.upsert({
      role: 'qa-agent',
      email: 'qa@slonk.local',
      plane_user_id: null,
      mode: 'single_bot',
      default_state: 'Testing',
      state_aliases: [],
    });
    const m = store.get('qa-agent');
    expect(m?.mode).toBe('single_bot');
    expect(m?.plane_user_id).toBeNull();
    // state_aliases затирается, не накапливается.
    expect(m?.state_aliases).toEqual([]);
    store.close();
  });

  it('all() returns rows sorted by role', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'z-agent',
      email: 'z@x',
      plane_user_id: null,
      mode: 'per_user',
      default_state: 'Testing',
      state_aliases: [],
    });
    store.upsert({
      role: 'a-agent',
      email: 'a@x',
      plane_user_id: null,
      mode: 'per_user',
      default_state: 'Analysis',
      state_aliases: [],
    });
    const rows = store.all();
    expect(rows.map((r) => r.role)).toEqual(['a-agent', 'z-agent']);
  });

  it('bootstrap_meta key/value', () => {
    const store = new IdentityStore({ path: ':memory:' });
    expect(store.getMeta('identity_mode')).toBeUndefined();
    store.setMeta('identity_mode', 'per_user');
    expect(store.getMeta('identity_mode')).toBe('per_user');
    store.setMeta('identity_mode', 'single_bot');
    expect(store.getMeta('identity_mode')).toBe('single_bot');
    store.close();
  });

  it('SLONK-6: stores empty state_aliases as [] (not null/undefined)', () => {
    const store = new IdentityStore({ path: ':memory:' });
    store.upsert({
      role: 'analyst-agent',
      email: 'a@slonk.local',
      plane_user_id: null,
      mode: 'per_user',
      default_state: 'Analysis',
      state_aliases: [],
    });
    const m = store.get('analyst-agent');
    expect(m?.state_aliases).toEqual([]);
    store.close();
  });

  it('SLONK-6: migration adds columns to legacy DB without breaking existing rows', () => {
    // Создаём «старую» БД ручным SQL — без новых колонок — затем открываем
    // её через IdentityStore. Миграция должна добавить колонки и сохранить
    // существующие данные; чтение должно вернуть default_state = null и
    // state_aliases = [] (дефолт для legacy-строк).
    const dbPath = ':memory:';
    // better-sqlite3 не создаёт два разных :memory:-файла как один и тот же,
    // поэтому используем общий handle: создаём БД, эмулируем legacy схему,
    // затем оборачиваем тем же путём — но IdentityStore::Database() создаст
    // НОВУЮ БД для :memory:. Чтобы протестировать миграцию, открываем
    // временный реальный файл.
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'slonk-store-mig-'));
    const path = join(dir, 'identity.sqlite');
    try {
      // Legacy схема: без default_state / state_aliases.
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE identity_mapping (
          role          TEXT PRIMARY KEY,
          email         TEXT NOT NULL,
          plane_user_id TEXT,
          mode          TEXT NOT NULL CHECK (mode IN ('per_user','single_bot')),
          updated_at    TEXT NOT NULL
        );
        CREATE TABLE bootstrap_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO identity_mapping (role, email, plane_user_id, mode, updated_at)
        VALUES ('old-agent', 'old@x', 'usr-old', 'per_user', '2026-01-01T00:00:00.000Z');
      `);
      legacy.close();
      // Открываем через IdentityStore — должна сработать миграция.
      const store = new IdentityStore({ path });
      const m = store.get('old-agent');
      expect(m?.role).toBe('old-agent');
      expect(m?.default_state).toBeNull();
      expect(m?.state_aliases).toEqual([]);
      // И апсерт по существующей роли тоже работает (заполняет новые колонки).
      store.upsert({
        role: 'old-agent',
        email: 'old@x',
        plane_user_id: 'usr-old',
        mode: 'per_user',
        default_state: 'Analysis',
        state_aliases: ['Анализ'],
      });
      const m2 = store.get('old-agent');
      expect(m2?.default_state).toBe('Analysis');
      expect(m2?.state_aliases).toEqual(['Анализ']);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SLONK-6: corrupt state_aliases JSON heals to empty array, does not crash', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'slonk-store-corrupt-'));
    const path = join(dir, 'identity.sqlite');
    try {
      const store = new IdentityStore({ path });
      store.upsert({
        role: 'r',
        email: 'r@x',
        plane_user_id: null,
        mode: 'per_user',
        default_state: 'S',
        state_aliases: ['a'],
      });
      store.close();
      // Грубо портим колонку state_aliases — невалидный JSON.
      const db = new Database(path);
      db.prepare(`UPDATE identity_mapping SET state_aliases = ? WHERE role = ?`).run(
        '{not-json',
        'r',
      );
      db.close();
      const store2 = new IdentityStore({ path });
      const m = store2.get('r');
      expect(m?.state_aliases).toEqual([]);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
