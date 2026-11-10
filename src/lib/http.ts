import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { hash, transaction } from './db';
export async function context() {
  const c = await cookies();
  return { session: c.get('lockd_session')?.value, guest: c.get('lockd_client')?.value };
}
export function checkOrigin(req: NextRequest) {
  const origin = process.env.APP_ORIGIN;
  if (!origin || req.headers.get('origin') !== origin)
    throw new Error('Request origin is not allowed');
}
export async function limit(key: string, count: number, seconds = 3600) {
  const allowed = await transaction(
    {},
    async (c) =>
      (await c.query('SELECT lockd.rate_limit($1,$2,$3) AS ok', [hash(key), count, seconds]))
        .rows[0].ok as boolean,
  );
  if (!allowed) throw new Error('Too many attempts. Please try again later.');
}
export function setSession(res: NextResponse, name: string, value: string, maxAge = 43200) {
  res.cookies.set(name, value, {
    httpOnly: true,
    secure: process.env.APP_ORIGIN?.startsWith('https://') ?? false,
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}
export function failure(e: unknown) {
  const err = e as Error & { code?: string };
  let message = 'Unable to complete this request.';
  let status = 400;
  if (e instanceof ZodError)
    message = e.issues.map((x) => `${x.path.join('.') || 'Form'}: ${x.message}`).join('; ');
  else if (err.code === '23P01') {
    message = 'That time is unavailable, including setup and travel buffers. Choose another date.';
    status = 409;
  } else if (err.code === '23505') {
    message = 'This profile, reference or evidence already exists. Check the existing record.';
    status = 409;
  } else if (err.code === '42501') {
    message = 'Sign in or open your private booking link to continue.';
    status = 403;
  } else if (err.code === 'P0001' || !err.code) message = err.message;
  return NextResponse.json({ error: message }, { status });
}
