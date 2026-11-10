import { z } from 'zod';
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const parishNames = [
  'Kingston',
  'St. Andrew',
  'St. Thomas',
  'Portland',
  'St. Mary',
  'St. Ann',
  'Trelawny',
  'St. James',
  'Hanover',
  'Westmoreland',
  'St. Elizabeth',
  'Manchester',
  'Clarendon',
  'St. Catherine',
] as const;
export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(128),
});
export const onboarding = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,49}$/),
    stageName: text(2, 100),
    parish: z.enum(parishNames),
    bio: text(10, 1500),
    depositInstructions: text(10, 2000),
    agreement: text(20, 12000),
    packageName: text(2, 120),
    description: text(10, 500),
    priceMinor: z.number().int().min(100).max(100000000),
    depositMinor: z.number().int().positive(),
    durationMinutes: z.number().int().min(30).max(1440),
    bufferBefore: z.number().int().min(0).max(720),
    bufferAfter: z.number().int().min(0).max(720),
  })
  .refine((d) => d.depositMinor <= d.priceMinor, { message: 'Deposit cannot exceed total price' });
export const capability = z.string().regex(/^[a-f0-9]{64}$/);
export const profileUpdate = onboarding.safeExtend({
  packageId: z.uuid(),
  revision: z.number().int().positive(),
  published: z.boolean(),
});
export const changeProposal = z.object({
  party: z.enum(['client', 'dj']),
  startsAt: z.iso.datetime({ offset: true }),
  reason: text(3, 1000),
});
export const changeResponse = z
  .object({
    amendmentId: z.uuid(),
    party: z.enum(['client', 'dj']),
    action: z.enum(['accept', 'decline', 'withdraw']),
    contentHash: capability,
    signer: text(0, 120),
    accept: z.boolean(),
  })
  .refine((d) => d.action !== 'accept' || (d.accept && d.signer.length >= 2), {
    message: 'Sign and accept the exact amended agreement',
  });
export const cancellationRequest = z.object({ reason: text(3, 1000) });
export const cancellationDecision = z
  .object({
    requestId: z.uuid().nullable(),
    approve: z.boolean(),
    refundMinor: z.number().int().min(0).max(100000000),
    reason: text(3, 1000),
    basis: text(10, 1000),
    attest: z.literal(true),
  })
  .refine((d) => d.approve || d.refundMinor === 0, {
    message: 'Declined requests cannot record a refund obligation',
  });
export const refundRecord = z.object({
  decisionId: z.uuid(),
  reference: text(2, 100),
  attest: z.literal(true),
});
export const refundAcknowledgement = z.object({ decisionId: z.uuid(), attest: z.literal(true) });
export const holdInput = z.object({
  creatorId: z.uuid(),
  packageId: z.uuid(),
  requestId: z.uuid(),
  accessToken: capability,
  startsAt: z.iso.datetime({ offset: true }),
  clientName: text(2, 120),
  clientEmail: z.email().max(254),
  venue: text(3, 400),
});
export const signatureInput = z.object({
  agreementId: z.uuid(),
  contentHash: capability,
  signer: text(2, 120),
  accept: z.literal(true),
});
export const verificationInput = z
  .object({
    claimId: z.uuid(),
    decision: z.enum(['received', 'rejected']),
    amountMinor: z.number().int().min(0).max(100000000),
    bankReference: text(0, 100),
    reason: text(3, 1000),
    attest: z.boolean(),
  })
  .refine(
    (d) =>
      d.decision === 'rejected'
        ? d.amountMinor === 0
        : d.attest && d.amountMinor > 0 && d.bankReference.length >= 2,
    { message: 'Record actual receipt, amount and bank reference, or reject with zero received' },
  );
export const blockInput = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: text(3, 300),
});
export function moneyToMinor(value: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value))
    throw new Error('Enter a JMD amount with up to two decimal places');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
