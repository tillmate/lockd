import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkOrigin, context, failure, limit, setSession } from '@/lib/http';
import { register, login, verifyEmail, resetPassword, requestReset, currentUser } from '@/lib/auth';
import { transaction } from '@/lib/db';
import * as service from '@/lib/service';
import * as billing from '@/lib/billing';
import * as ops from '@/lib/ops';
import * as support from '@/lib/support';
import { emailEnabled, stagingMode } from '@/lib/env';
import { capability } from '@/lib/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ path: string[] }> };
export async function POST(req: NextRequest, { params }: Params) {
  try {
    checkOrigin(req);
    const { path } = await params;
    const route = path.join('/');
    const ctx = await context();
    // Hard bound while streaming; do not trust Content-Length or parse arbitrarily large multipart bodies.
    const max = route.endsWith('/proof') ? 5 * 1024 * 1024 + 65536 : 32768;
    if (Number(req.headers.get('content-length') ?? 0) > max)
      throw new Error('Upload is too large');
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new Error('Upload is too large');
        }
        chunks.push(value);
      }
    const raw = Buffer.concat(chunks);
    const parse = () => JSON.parse(raw.toString('utf8')) as unknown;
    // The staging demo has no email delivery yet: sign-up and reset links could never arrive.
    if ((route === 'auth/register' || route === 'auth/forgot') && stagingMode() && !emailEnabled())
      throw new Error('Email is not enabled on this demo. Sign in with the demo account instead.');
    if (route === 'auth/register' || route === 'auth/login') {
      const d = z
        .object({ email: z.email().max(254), password: z.string().min(12).max(128) })
        .parse(parse());
      await limit(`auth:${d.email.toLowerCase()}`, 20);
      await limit('auth:global', 300);
      if (route === 'auth/register') {
        await register(d);
        return NextResponse.json({ ok: true, message: 'Check your email to verify your account.' });
      }
      const token = await login(d);
      const res = NextResponse.json({ ok: true });
      setSession(res, 'lockd_session', token);
      return res;
    }
    if (route === 'auth/verify') {
      const d = z.object({ token: capability }).parse(parse());
      if (!(await verifyEmail(d.token))) throw new Error('Verification link is invalid or expired');
      return NextResponse.json({ ok: true });
    }
    if (route === 'auth/logout') {
      await transaction(ctx, async (c) => {
        await c.query('SELECT lockd.logout()');
      });
      const res = NextResponse.json({ ok: true });
      setSession(res, 'lockd_session', '', 0);
      return res;
    }
    if (route === 'auth/forgot') {
      const d = z.object({ email: z.email().max(254) }).parse(parse());
      await limit(`reset:${d.email.toLowerCase()}`, 5);
      await requestReset(d.email);
      return NextResponse.json({ ok: true });
    }
    if (route === 'auth/reset') {
      const d = z
        .object({ token: capability, password: z.string().min(12).max(128) })
        .parse(parse());
      if (!(await resetPassword(d.token, d.password)))
        throw new Error('Reset link is invalid or expired');
      return NextResponse.json({ ok: true });
    }
    if (route === 'onboard') {
      const id = await service.onboard(ctx, parse());
      return NextResponse.json({ id });
    }
    if (route === 'settings') {
      await service.updateProfile(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'settings/socials') {
      await service.setSocials(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'billing/invoices') {
      await limit(`invoices:${ctx.session ?? 'anonymous'}`, 20);
      return NextResponse.json({ id: await billing.issue(ctx, parse()) });
    }
    if (route === 'staff/mfa') {
      await billing.stepUp(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'staff/approve-founding') {
      await billing.approve(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'staff/listings/review')
      return NextResponse.json({ state: await ops.reviewListing(ctx, parse()) });
    if (route === 'staff/notifications/requeue') {
      await ops.requeue(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'staff/scopes') {
      await ops.setScope(ctx, parse());
      return NextResponse.json({ ok: true });
    }
    if (route === 'staff/cases')
      return NextResponse.json({ id: await support.openCase(ctx, parse()) });
    if (path[0] === 'staff' && path[1] === 'cases' && path.length === 4) {
      const id = z.uuid().parse(path[2]);
      const action = path[3];
      if (action === 'link') await support.linkBooking(ctx, id, parse());
      else if (action === 'notes') await support.addNote(ctx, id, parse());
      else if (action === 'extend')
        return NextResponse.json({ until: await support.extendAccess(ctx, id, parse()) });
      else if (action === 'close') await support.closeCase(ctx, id, parse());
      else if (action === 'receipt') {
        await limit(`case-receipt:${ctx.session ?? 'anonymous'}`, 60);
        const image = await support.caseReceipt(ctx, id, parse());
        return new NextResponse(new Uint8Array(image), {
          headers: {
            'Content-Type': 'image/png',
            'Content-Disposition': 'inline; filename="case-evidence.png"',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } else return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (path[0] === 'invoices' && path.length === 3) {
      const id = z.uuid().parse(path[1]);
      if (path[2] === 'proof') {
        if (!(await billing.invoice(ctx, id))) throw new Error('Invoice access required');
        await limit(`invoice-proof:${id}`, 30);
        const form = await new Response(raw, {
          headers: { 'Content-Type': req.headers.get('content-type') ?? '' },
        }).formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw new Error('Choose a PNG or JPEG receipt');
        return NextResponse.json({
          id: await billing.upload(
            ctx,
            id,
            String(form.get('reference') ?? ''),
            Number(form.get('amountMinor')),
            Buffer.from(await file.arrayBuffer()),
          ),
        });
      }
      if (path[2] === 'reconcile')
        return NextResponse.json({ state: await billing.reconcile(ctx, id, parse()) });
      if (path[2] === 'void') {
        await billing.voidInvoice(ctx, id, parse());
        return NextResponse.json({ ok: true });
      }
    }
    if (route === 'holds') {
      const d = z
        .object({ creatorId: z.uuid(), clientEmail: z.email(), accessToken: capability })
        .passthrough()
        .parse(parse());
      await limit(`holds:creator:${d.creatorId}`, 100);
      await limit(`holds:email:${d.clientEmail.toLowerCase()}`, 15);
      const id = await service.createHold(d);
      const res = NextResponse.json({ id });
      setSession(res, 'lockd_client', d.accessToken, 3600);
      return res;
    }
    if (route === 'access') {
      const d = z.object({ id: z.uuid(), token: capability }).parse(parse());
      await limit(`access:${d.id}`, 60);
      if (!(await service.booking({ guest: d.token }, d.id)))
        throw new Error('Private booking link is invalid or expired');
      const res = NextResponse.json({ ok: true });
      setSession(res, 'lockd_client', d.token, 3600);
      return res;
    }
    if (path[0] === 'bookings' && path.length === 3 && path[2] === 'request-link') {
      const bid = z.uuid().parse(path[1]);
      const d = z.object({ email: z.email().max(254) }).parse(parse());
      // Keyed by booking and address, so guesses with other addresses cannot use up the real
      // client's allowance; a coarse per-booking ceiling still stops floods.
      await limit(`link:${bid}:${d.email.toLowerCase()}`, 5);
      await limit(`link:${bid}`, 60);
      await limit(`link:email:${d.email.toLowerCase()}`, 10);
      await service.requestGuestLink(bid, d);
      return NextResponse.json({ ok: true });
    }
    if (path[0] === 'bookings' && path.length === 3) {
      const bid = z.uuid().parse(path[1]);
      const action = path[2];
      if (action === 'sign') await service.sign(ctx, bid, parse());
      else if (action === 'proof') {
        if (!(await service.booking(ctx, bid))) throw new Error('Private booking access required');
        await limit(`proof:${bid}`, 30);
        const form = await new Response(raw, {
          headers: { 'Content-Type': req.headers.get('content-type') ?? '' },
        }).formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw new Error('Choose a PNG or JPEG receipt');
        const amount = Number(form.get('amountMinor'));
        const id = await service.proof(
          ctx,
          bid,
          String(form.get('reference') ?? ''),
          amount,
          Buffer.from(await file.arrayBuffer()),
        );
        return NextResponse.json({ id });
      } else if (action === 'verify')
        return NextResponse.json({ status: await service.verify(ctx, bid, parse()) });
      else if (action === 'complete') await service.complete(ctx, bid);
      else if (action === 'propose-change') {
        await limit(`changes:${bid}`, 30);
        await service.proposeChange(ctx, bid, parse());
      } else if (action === 'respond-change') await service.respondChange(ctx, bid, parse());
      else if (action === 'request-cancellation') {
        await limit(`cancellations:${bid}`, 15);
        await service.requestCancellation(ctx, bid, parse());
      } else if (action === 'decide-cancellation')
        await service.decideCancellation(ctx, bid, parse());
      else if (action === 'record-refund') await service.recordRefund(ctx, bid, parse());
      else if (action === 'acknowledge-refund') await service.acknowledgeRefund(ctx, bid, parse());
      else return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (route === 'blocks') return NextResponse.json({ id: await service.block(ctx, parse()) });
    if (route === 'blocks/remove') {
      const d = z.object({ id: z.uuid() }).parse(parse());
      await service.unblock(ctx, d.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (e) {
    return failure(e);
  }
}
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { path } = await params;
    const ctx = await context();
    if (path[0] === 'invoices' && path.length === 2) {
      const data = await billing.invoice(ctx, path[1]);
      return NextResponse.json(data ?? { error: 'Invoice not found' }, {
        status: data ? 200 : 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (path[0] === 'invoice-receipts' && path.length === 2) {
      const r = await billing.receipt(ctx, path[1]);
      if (!r) return new NextResponse(null, { status: 404 });
      return new NextResponse(new Uint8Array(r.image), {
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': 'attachment; filename="invoice-receipt.png"',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (path[0] === 'bookings' && path.length === 2) {
      const data = await service.booking(ctx, path[1]);
      return NextResponse.json(data ?? { error: 'Booking not found' }, {
        status: data ? 200 : 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (path[0] === 'receipts' && path.length === 2) {
      const row = await service.receipt(ctx, path[1]);
      if (!row) return new NextResponse(null, { status: 404 });
      return new NextResponse(new Uint8Array(row.image), {
        headers: {
          'Content-Type': row.mime,
          'Content-Disposition': 'attachment; filename="receipt.png"',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (path[0] === 'me') return NextResponse.json({ id: await currentUser(ctx) });
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (e) {
    return failure(e);
  }
}
