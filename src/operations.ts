import { z } from 'zod';

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const quantity = z.number().int().min(1).max(100_000);
export const operationInput = z.strictObject({
  scenario: z
    .strictObject({
      id: z.uuid(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000),
      orders: z
        .array(
          z.strictObject({
            id: identifier,
            factory: identifier,
            part: identifier,
            quantity,
            deadlineHours: z.number().positive().max(8760),
            priority: z.number().int().min(1).max(1000),
          }),
        )
        .min(1)
        .max(100),
      lanes: z
        .array(
          z.strictObject({
            id: identifier,
            warehouse: identifier,
            factory: identifier,
            mode: identifier,
            hours: z.number().nonnegative().max(8760),
            unitCost: z.number().int().nonnegative().max(10000),
            capacity: quantity,
          }),
        )
        .min(1)
        .max(500),
    })
    .superRefine((scenario, ctx) => {
      for (const field of ['orders', 'lanes'] as const) {
        if (new Set(scenario[field].map((item) => item.id)).size !== scenario[field].length)
          ctx.addIssue({ code: 'custom', path: [field], message: 'Identifiers must be unique.' });
      }
    }),
});
