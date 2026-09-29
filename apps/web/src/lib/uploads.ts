import { apiPost } from '@/lib/api';

export type UploadPurpose = 'breakdown' | 'diagnosis' | 'completion' | 'verification' | 'profile' | 'vehicle' | 'invoice';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Presigns, uploads to R2 via the worker relay, and returns the object key. */
export async function uploadToR2(file: File, purpose: UploadPurpose, entityId?: string): Promise<string> {
  const presign = await apiPost<{ uploadUrl: string; objectKey: string; headers: Record<string, string> }>(
    '/api/uploads/presign',
    {
      purpose,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      ...(entityId ? { entityId } : {}),
    },
  );
  const put = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: presign.headers,
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status}). Please try again.`);
  return presign.objectKey;
}
