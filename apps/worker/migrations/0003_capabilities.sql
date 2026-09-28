-- Motoro - vehicle type capability + service report artifacts
PRAGMA foreign_keys = ON;

CREATE TABLE mechanic_vehicle_types (
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  vehicle_type     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (mechanic_user_id, vehicle_type)
);
CREATE INDEX idx_mechanic_vehicle_types_type ON mechanic_vehicle_types (vehicle_type);

CREATE TABLE service_reports (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  object_key   TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_service_reports_request ON service_reports (request_id);
