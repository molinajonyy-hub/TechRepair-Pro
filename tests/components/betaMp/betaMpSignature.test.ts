// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { signatureManifest, validateMpSignature } from '../../../supabase/functions/_shared/billing/mpSignature.ts'

const secret = 'local-regression-secret'
const hash = (manifest: string) => createHmac('sha256', secret).update(manifest).digest('hex')
const request = (signature: string, requestId?: string) => new Request('https://edge.test/?data.id=ABC123', {
  headers: { 'x-signature': signature, ...(requestId === undefined ? {} : { 'x-request-id': requestId }) },
})

describe('official Mercado Pago signature manifest', () => {
  it.each(['1790000000', '1790000000123'])('seconds/milliseconds stay opaque: %s', async ts => {
    const sig = hash(`id:abc123;request-id:req-A;ts:${ts};`)
    expect(await validateMpSignature(request(`ts=${ts},v1=${sig}`, 'req-A'), 'ABC123', secret)).toBe('ok')
  })
  it('omits a missing request id; does not sign an empty request-id pair', async () => {
    const sig = hash('id:abc123;ts:1790000000;')
    expect(await validateMpSignature(request(`v1=${sig}, ts=1790000000`), 'ABC123', secret)).toBe('ok')
    expect(signatureManifest('ABC123', '', '1790000000')).toBe('id:abc123;ts:1790000000;')
  })
  it('omits missing URL id, without inserting a body id; handler separately rejects unsigned resources', async () => {
    expect(await validateMpSignature(request(`ts=1790000000,v1=${hash('ts:1790000000;')}`), undefined, secret)).toBe('ok')
    expect(signatureManifest(undefined, 'req-A', '1790000000')).toBe('request-id:req-A;ts:1790000000;')
  })
  it('header field order and whitespace do not affect the signed values', async () => {
    const sig = hash('id:abc123;request-id:req-A;ts:1790000000;')
    expect(await validateMpSignature(request(` v1 = ${sig} , ts = 1790000000 `, 'req-A'), 'ABC123', secret)).toBe('ok')
  })
  it('no secret is a configuration error; another secret cannot authenticate the request', async () => {
    const req = request(`ts=1790000000,v1=${hash('id:abc123;ts:1790000000;')}`)
    expect(await validateMpSignature(req, 'abc123', undefined)).toBe('missing_secret')
    expect(await validateMpSignature(req, 'abc123', 'wrong-secret')).toBe('invalid')
  })
  it.each(['', 'ts=abc,v1=' + '0'.repeat(64), 'ts=1,v1=xyz', 'ts=1,ts=2,v1=' + '0'.repeat(64),
    'ts=1,v1=' + '0'.repeat(64) + ',v1=' + '1'.repeat(64)])('rejects malformed/ambiguous signatures: %s', async sig => {
    expect(await validateMpSignature(request(sig), 'abc123', secret)).toBe('invalid')
  })
  it('changing the resource or preserving an incorrect request-id case breaks authentication', async () => {
    const req = request(`ts=1790000000,v1=${hash('id:abc123;request-id:req-A;ts:1790000000;')}`, 'req-a')
    expect(await validateMpSignature(req, 'abc123', secret)).toBe('invalid')
    expect(await validateMpSignature(request(`ts=1790000000,v1=${hash('id:abc123;ts:1790000000;')}`), 'another', secret)).toBe('invalid')
  })
  it('manifest separators/control characters cannot be injected into resource or request id', () => {
    expect(signatureManifest('a;request-id:b', '', '1')).toBeNull()
    expect(signatureManifest('abc', 'a\nb', '1')).toBeNull()
  })
})
