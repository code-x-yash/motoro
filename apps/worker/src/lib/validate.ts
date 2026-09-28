import type { z, ZodTypeAny } from 'zod';
import { errors } from './errors';

/** Validate untrusted input against a Zod schema, throwing a typed AppError. */
export function parseInput<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    throw errors.validation('Please check the highlighted fields.', details);
  }
  return result.data;
}
