// Источник правды для списка известных agent-identities — bootstrap manifest и
// SQLite-стор, заполняемый при `make bootstrap`. Этот модуль определяет
// рантайм-реестр (`IdentityRegistry`), который собирается на старте сервера и
// прокидывается в `authenticate(...)` вместо захардкоженного `Set<string>`.
//
// Сужение `AgentIdentity` до `string` сознательное: список ролей теперь
// зависит от конфигурации конкретной установки, и тип не может его выразить.
// Все потребители `AgentIdentity` используют его номинально (поля, параметры),
// `=== 'developer-agent'` в коде не встречается — `grep -rn` это подтверждает.

import type { Manifest } from './bootstrap/manifest.js';
import type { IdentityStore } from './bootstrap/store.js';

export type AgentIdentity = string;

export interface IdentityRegistry {
  /** Зарегистрирована ли такая роль. */
  has(id: string): boolean;
  /** Отсортированный snapshot для диагностики/логов. */
  list(): readonly string[];
  /** Количество ролей (удобно для метрик и тестов). */
  size: number;
}

class SetRegistry implements IdentityRegistry {
  private readonly set: ReadonlySet<string>;

  constructor(roles: Iterable<string>) {
    const collected = new Set<string>();
    for (const r of roles) {
      if (typeof r === 'string' && r.length > 0) collected.add(r);
    }
    this.set = collected;
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  list(): readonly string[] {
    return [...this.set].sort();
  }

  get size(): number {
    return this.set.size;
  }
}

export function createIdentityRegistry(roles: Iterable<string>): IdentityRegistry {
  return new SetRegistry(roles);
}

export function createIdentityRegistryFromManifest(manifest: Manifest): IdentityRegistry {
  return new SetRegistry(manifest.identities.map((i) => i.role));
}

export function createIdentityRegistryFromStore(store: IdentityStore): IdentityRegistry {
  return new SetRegistry(store.all().map((r) => r.role));
}
