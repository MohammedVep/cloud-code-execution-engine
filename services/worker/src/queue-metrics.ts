export const getQueueDepth = (waitingCount: number, activeCount: number): number =>
  Math.max(0, waitingCount) + Math.max(0, activeCount);
