export const money = (minor: number) =>
  'J$' +
  new Intl.NumberFormat('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
export const date = (value: Date | string) =>
  new Intl.DateTimeFormat('en-JM', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Jamaica',
  }).format(new Date(value));
export const statusLabel = (s: string) =>
  ({
    AWAITING_SIGNATURE: 'Agreement ready',
    AWAITING_DEPOSIT: 'Awaiting direct deposit',
    VERIFICATION_PENDING: 'DJ verification pending',
    PROOF_REJECTED: 'Evidence needs attention',
    PARTIAL_VERIFIED: 'Partial deposit verified',
    CONFIRMED_LOCKD: 'Confirmed · Lockd',
    HOLD_EXPIRED: 'Hold expired',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  })[s] ?? s;
