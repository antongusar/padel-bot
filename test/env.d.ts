declare namespace Cloudflare {
  interface Env {
    BROWSER: BrowserRun;
    MONITOR_STATE: KVNamespace;
    JOIN_COORDINATOR: DurableObjectNamespace;
    OPERATION_LOGS: DurableObjectNamespace;
    MONITOR_SCHEDULER: DurableObjectNamespace;
  }
}
