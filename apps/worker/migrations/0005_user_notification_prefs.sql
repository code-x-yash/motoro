-- Per-user notification channel preferences (opt-out model: missing key = enabled).
ALTER TABLE users ADD COLUMN notification_prefs_json TEXT;
