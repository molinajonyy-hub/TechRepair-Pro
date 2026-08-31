// Local Docker only. Never accepts a remote database URL. Entire test rolls back.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id = "([a-z0-9-]+)"/m)?.[1]
if (!project) throw new Error('Cannot identify local database container')
const migration = readFileSync('supabase/migrations/20260906120000_mp_pos_beta_containment.sql', 'utf8')
  .replace(/^(BEGIN|COMMIT);\s*$/gm, '')
const tests = readFileSync('tests/sql/mp_pos_beta_containment.test.sql', 'utf8')
const sql = `BEGIN;
-- Synthetic credentials, never a real merchant. Exercise a non-empty table.
INSERT INTO public.businesses(id, name) VALUES
 ('00000000-0000-4000-8000-00000000b371', 'MP containment rollback fixture');
INSERT INTO public.mp_accounts(business_id, access_token_encrypted, refresh_token_encrypted)
 VALUES ('00000000-0000-4000-8000-00000000b371', 'SYNTHETIC-ACCESS', 'SYNTHETIC-REFRESH');
CREATE TEMP TABLE mp_beta_before ON COMMIT DROP AS
 SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) AS fingerprint FROM public.mp_accounts a;
${migration}
${tests}
DO $preservation$
BEGIN
 IF (SELECT fingerprint FROM mp_beta_before) IS DISTINCT FROM
    (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM public.mp_accounts a) THEN
   RAISE EXCEPTION 'Account rows or ciphertext changed';
 END IF;
END;
$preservation$;
ROLLBACK;`
try {
  execFileSync('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  console.log('PASS: anon/authenticated denied; restrictive RLS; service access and all rows/ciphertext preserved; ROLLBACK.')
} catch (error) {
  console.error(error.stderr?.toString() || error.message)
  process.exitCode = 1
}
