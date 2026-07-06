type DebugLogger = ((...args: unknown[]) => void) & {
  enabled: boolean;
  namespace: string;
  extend: (suffix: string) => DebugLogger;
};

function createDebug(namespace = ""): DebugLogger {
  const logger = (() => undefined) as DebugLogger;
  logger.enabled = false;
  logger.namespace = namespace;
  logger.extend = (suffix: string) => createDebug(namespace ? `${namespace}:${suffix}` : suffix);
  return logger;
}

export default createDebug;
