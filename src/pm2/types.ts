/** The parts of a pm2.list() entry this module relies on. */
export interface Pm2Env {
  status?: string;
  pm_id?: number;
  name?: string;
  namespace?: string;
  exec_mode?: string;
  merge_logs?: boolean;
  pmx_module?: boolean;
  disable_logs?: boolean;
  pm_out_log_path?: string;
  pm_err_log_path?: string;
  [key: string]: unknown;
}

export interface Pm2Process {
  pid?: number;
  name?: string;
  pm_id?: number;
  pm2_env: Pm2Env;
}

/** PM2 writes nothing when the path is a null device. */
export function isNullPath(p: string | undefined | null): boolean {
  if (!p) return true;
  const n = p.trim().toLowerCase();
  return n === '/dev/null' || n === 'nul' || n === '\\\\.\\nul';
}

export function isModule(p: Pm2Process): boolean {
  return p.pm2_env?.pmx_module === true;
}
