import { z } from 'zod';

export const PluginManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(500),
    permissions: z
      .array(z.enum(['snapshot:read', 'context:read']))
      .min(1)
      .max(2),
    instructions: z.string().min(1).max(8000),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (!manifest.permissions.includes('snapshot:read'))
      ctx.addIssue({ code: 'custom', message: 'snapshot:read is required.' });
    if (new Set(manifest.permissions).size !== manifest.permissions.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate permissions.' });
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginPermission = PluginManifest['permissions'][number];
