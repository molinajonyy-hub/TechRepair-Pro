import { assert, assertEquals } from 'jsr:@std/assert'
import { CLIENT_CONTRACT_HEADER, userDataApiHeaders } from '../../supabase/functions/_shared/clientContract.ts'

Deno.test('forwards the exact client contract on user-scoped Data API calls', () => {
  const req = new Request('http://localhost/functions/v1/test', {
    headers: { [CLIENT_CONTRACT_HEADER]: '1' },
  })
  assertEquals(userDataApiHeaders(req, 'Bearer signed-user-jwt'), {
    Authorization: 'Bearer signed-user-jwt',
    [CLIENT_CONTRACT_HEADER]: '1',
  })
})

Deno.test('does not invent a contract when the caller omitted it', () => {
  const req = new Request('http://localhost/functions/v1/test')
  const headers = userDataApiHeaders(req, 'Bearer signed-user-jwt')
  assertEquals(headers, { Authorization: 'Bearer signed-user-jwt' })
  assert(!(CLIENT_CONTRACT_HEADER in headers))
})

Deno.test('forwards malformed values for the backend gate to reject', () => {
  const req = new Request('http://localhost/functions/v1/test', {
    headers: { [CLIENT_CONTRACT_HEADER]: 'abc' },
  })
  assertEquals(userDataApiHeaders(req, 'Bearer signed-user-jwt')[CLIENT_CONTRACT_HEADER], 'abc')
})
