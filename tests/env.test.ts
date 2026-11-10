import { afterEach, describe, expect, it } from 'vitest';
import { pgConfig } from '../src/lib/env';

// TLS options for managed Postgres (docs/STAGING.md): libpq meanings, never silently downgraded.
describe('pgConfig', () => {
  const saved = { ca: process.env.DB_CA_CERT, mode: process.env.DB_SSLMODE };
  afterEach(() => {
    for (const [key, value] of [
      ['DB_CA_CERT', saved.ca],
      ['DB_SSLMODE', saved.mode],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  it('passes local and explicit URLs through unchanged', () => {
    delete process.env.DB_CA_CERT;
    delete process.env.DB_SSLMODE;
    const local = 'postgresql://lockd_runtime:pw@127.0.0.1:55432/lockd';
    expect(pgConfig(local)).toEqual({ connectionString: local });
    const strict = 'postgresql://u:pw@db.example.com:25060/lockd?sslmode=verify-full';
    expect(pgConfig(strict)).toEqual({ connectionString: strict });
  });
  it('encrypts sslmode=require connections, including role URLs derived from the owner URL', () => {
    delete process.env.DB_CA_CERT;
    delete process.env.DB_SSLMODE;
    expect(
      pgConfig('postgresql://doadmin:pw@db.example.com:25060/defaultdb?sslmode=require'),
    ).toEqual({
      connectionString: 'postgresql://doadmin:pw@db.example.com:25060/defaultdb',
      ssl: { rejectUnauthorized: false },
    });
    process.env.DB_SSLMODE = 'require';
    expect(pgConfig('postgresql://lockd_runtime:pw@db.example.com:25060/defaultdb').ssl).toEqual({
      rejectUnauthorized: false,
    });
  });
  it('verifies the server against a provided CA', () => {
    process.env.DB_CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const config = pgConfig('postgresql://u:pw@db.example.com:25060/defaultdb?sslmode=require');
    expect(config.connectionString).toBe('postgresql://u:pw@db.example.com:25060/defaultdb');
    expect(config.ssl).toMatchObject({
      ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    });
  });
});
