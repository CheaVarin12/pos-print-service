/** Shapes of the Laravel Print Service v2 API (see little-duckling-api/docs/PRINT_SERVICE_V2.md). */

export interface ApiPrinter {
  id: number;
  name: string | null;
  connection: "network" | "usb";
  ip: string | null;
  port: number;
  paper_width: number;
  print_type?: string | null;
  bill_type?: string | null;
  product_group_id?: number | null;
  bound_to_this_device?: boolean;
}

export interface ApiDocument {
  id: string;
  kind: string;
  width: number;
  height: number;
  sha256: string;
  content_url: string;
}

export interface ApiTask {
  id: string;
  claim_token: string;
  job_type: string;
  copies: number;
  attempt: number;
  max_attempts: number;
  lease_expires_at: string | null;
  printer: ApiPrinter | null;
  document: ApiDocument | null;
}

export interface SyncResponse {
  status: string;
  server_time: string;
  device: { id: string; branch_id: number };
  leases: { renewed: string[]; lost: string[] };
  tasks: ApiTask[];
  printers: ApiPrinter[];
}

export interface InProgressItem {
  id: string;
  claim_token: string;
}

export type AckStatus = "printed" | "failed";

export interface AckItem {
  id: string;
  claim_token: string;
  status: AckStatus;
  error_code?: string | null;
  error?: string | null;
}

export type AckResult = "ok" | "already_printed" | "already_failed" | "stale" | "not_found";

export interface AckResponse {
  status: string;
  results: Array<{ id: string; result: AckResult }>;
}

export interface PairResponse {
  status: string;
  token: string;
  device: { id: string; name: string; branch_id: number; shop_id: number | null };
  server_time: string;
}

export interface HeartbeatPrinter {
  id: number;
  online: boolean;
  status_code?: string | null;
  message?: string | null;
}
