import { z } from 'zod';

// who_am_i не принимает аргументов; пустой объект — это валидная zod-схема
// для tool'а без полей. Файл сохранён ради конвенции «один tool — одна
// директория с schema.ts/handler.ts/handler.test.ts» (CONVENTIONS §4).
export const WhoAmIInput = z.object({});
export type WhoAmIInput = z.infer<typeof WhoAmIInput>;
