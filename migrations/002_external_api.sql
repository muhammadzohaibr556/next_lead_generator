CREATE TABLE external_api_idempotency (
  idempotency_key text PRIMARY KEY,
  request_hash text NOT NULL,
  response_status integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
