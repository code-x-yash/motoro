-- Disputes get a category so admins can triage (reason stays freeform detail).
ALTER TABLE disputes ADD COLUMN category TEXT NOT NULL DEFAULT 'OTHER';
