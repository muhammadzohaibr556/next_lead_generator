export type Raw = Record<string, unknown>;
export interface Match {
  kind: "Direct" | "Adjacent";
  evidence: string;
  confidence: number;
}
export interface Permit {
  permit_number: string;
  project_ref: string;
  project_key: string;
  address: string;
  address_key: string;
  zip: string;
  apn: string;
  description: string;
  permit_type: string;
  property_type: string;
  applied_date: string;
  issue_date: string;
  completed_date: string;
  activity_date: string;
  signal_date: string;
  signal_date_kind: string;
  date_warning: boolean;
  raw_status: string;
  stage: string;
  contractor: string;
  contractor_phone: string;
  permit_holder: string;
  owner: string;
  latitude: number | null;
  longitude: number | null;
  source_id: string;
  jurisdiction: string;
  city: string;
  state: string;
  source_url: string;
  value: number | null;
  sqft: number | null;
  county?: string;
}
export interface LeadPayload extends Permit {
  match: Match;
  permit_count: number;
  trade_permit_count: number;
  score_base: number;
  grouping: string;
}
export interface Lead extends LeadPayload {
  id: number;
  trade: string;
  active: boolean;
  first_seen: string;
  updated_at: string;
  status: string;
  saved: boolean;
  notes: string;
  assigned_to: string;
  score: number;
  score_breakdown: Record<string, number>;
  has_party: boolean;
  focus_reasons: string[];
  in_focus: boolean;
  availability: string;
  location_provider: string;
  location_method: string;
  location_status: string;
}
export interface Source {
  name: string;
  city: string;
  state: string;
  jurisdiction: string;
  kind: string;
  url: string;
  page: string;
  interval: number;
  freshness: string;
  default_stage: string;
  dates?: string[];
  where?: string;
  feed?: string;
  required?: string[];
  client_dates?: string[];
  object_id?: string;
  scope?: string;
}
